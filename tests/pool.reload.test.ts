// P0-2 / 热重载回归测试（源自已删除的 scripts/p0-regression.ts，迁入 bun:test 生态）
// 覆盖三个契约：
//   1. 基线：echo 夹具服务器可建立 READY 会话并注册 ping 工具
//   2. P0-2：热重载到坏配置时，既有 READY 会话原样保留、工具仍可调用
//   3. 热重载成功路径（好配置→好配置）：map 指向新会话且新会话 READY（旧会话
//      清理失败不得影响新会话——2026-09-21 finding 1 修复的行为契约）
import { describe, test, expect, onTestFinished } from 'bun:test';
import { join, resolve } from 'node:path';
import { McpPool } from '../src/mcp/pool';

const ROOT = resolve(import.meta.dir, '..');
const ECHO = join(ROOT, 'tests', 'fixtures', 'echo-server.ts');

const echoConfig = { command: process.execPath, args: [ECHO], timeout: 15000 } as const;
const badConfig = { command: 'definitely-not-exist-cmd-p0test' } as const;

describe('热重载回归（P0-2 + 成功路径隔离）', () => {
    test('失败重载保留既有 READY 会话，成功重载切换到新 READY 会话', async () => {
        const pool = new McpPool();
        onTestFinished(() => void pool.shutdown());

        // [1] 基线
        await pool.addServer('echo', echoConfig);
        const baseline = pool.getSession('echo');
        expect(baseline?.state).toBe('READY');
        expect(baseline?.tools.has('ping')).toBe(true);

        // [2] P0-2：坏配置重载失败 → 旧 READY 会话原样保留
        await pool.addServer('echo', badConfig);
        const afterFail = pool.getSession('echo');
        expect(afterFail).toBe(baseline);
        expect(afterFail?.state).toBe('READY');
        const callResult = await afterFail!.callTool('ping');
        expect(JSON.stringify(callResult)).toContain('pong');

        // [3] 成功重载：map 切换到新实例且 READY（finding 1 隔离契约的正面路径）
        await pool.addServer('echo', echoConfig);
        const afterReload = pool.getSession('echo');
        expect(afterReload).not.toBe(baseline);
        expect(afterReload?.state).toBe('READY');
        const reloadCall = await afterReload!.callTool('ping');
        expect(JSON.stringify(reloadCall)).toContain('pong');

        await pool.shutdown();
    }, 30000);
});
