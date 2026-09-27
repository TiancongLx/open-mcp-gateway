// enabled 特性开关回归测试（配置级服务停用）。覆盖四个契约：
//   1. enabled=false：initialize 不建立会话、登记入禁用表
//   2. 禁用→启用：reconcile 挂载会话并就绪、禁用登记撤销
//   3. 启用→禁用：reconcile 下线既有会话、重新登记禁用
//   4. 网关语义：/servers 呈现 DISABLED 占位，openapi.json 与工具路由返回 503
import { describe, test, expect, onTestFinished } from 'bun:test';
import { join, resolve } from 'node:path';
import { McpPool } from '../src/mcp/pool';
import { GatewayServer } from '../src/server/gateway';

const ROOT = resolve(import.meta.dir, '..');
const ECHO = join(ROOT, 'tests', 'fixtures', 'echo-server.ts');
const PORT = 19096;
const BASE = `http://127.0.0.1:${PORT}`;

const echoConfig = { command: process.execPath, args: [ECHO], timeout: 15000 };

describe('连接池 enabled 特性开关', () => {
    test('禁用不挂载、启用挂载、再禁用下线', async () => {
        const pool = new McpPool();
        onTestFinished(() => void pool.shutdown());

        // [1] 初始禁用：不建立会话、登记禁用表
        await pool.initialize({ mcpServers: { echo: { ...echoConfig, enabled: false } } });
        expect(pool.getSession('echo')).toBeUndefined();
        expect(pool.getDisabledServers().has('echo')).toBe(true);

        // [2] 禁用→启用：挂载并就绪、禁用登记撤销
        await pool.reconcile({ mcpServers: { echo: { ...echoConfig } } });
        const enabled = pool.getSession('echo');
        expect(enabled?.state).toBe('READY');
        expect(enabled?.tools.has('ping')).toBe(true);
        expect(pool.getDisabledServers().has('echo')).toBe(false);

        // [3] 启用→禁用：会话下线、重新登记禁用
        await pool.reconcile({ mcpServers: { echo: { ...echoConfig, enabled: false } } });
        expect(pool.getSession('echo')).toBeUndefined();
        expect(pool.getDisabledServers().has('echo')).toBe(true);
    }, 30000);

    test('/servers 呈现 DISABLED 占位，禁用服务路由返回 503', async () => {
        const pool = new McpPool();
        await pool.initialize({ mcpServers: { echo: { ...echoConfig, enabled: false } } });
        const server = new GatewayServer(pool, { port: PORT, host: '127.0.0.1' });
        server.setPoolReady(true);
        server.start();
        onTestFinished(() => {
            server.stop();
            void pool.shutdown();
        });

        const registry = (await (await fetch(`${BASE}/servers`)).json()) as any;
        expect(registry.servers.echo.state).toBe('DISABLED');
        expect(registry.servers.echo.toolCount).toBe(0);

        const spec = await fetch(`${BASE}/echo/openapi.json`);
        expect(spec.status).toBe(503);
        expect(((await spec.json()) as any).state).toBe('DISABLED');

        const call = await fetch(`${BASE}/echo/ping`, { method: 'POST', body: '{}' });
        expect(call.status).toBe(503);
        expect(((await call.json()) as any).state).toBe('DISABLED');
    }, 30000);
});
