// 图像整形（服务级开关 + 三态协商）HTTP 集成测试：真实 GatewayServer + 图像夹具节点。
// 覆盖契约：
//   1. 默认（inline）：单图像块结果 → 裸 data: URI 字符串（text/plain）
//   2. Accept: image/* → 裸图像字节；Accept: application/json → JSON 信封（逃生口）
//   3. 整形不适用（多图像块 / 纯文本 / isError）→ JSON 信封
import { describe, test, expect, onTestFinished } from 'bun:test';
import { join, resolve } from 'node:path';
import { McpPool } from '../src/mcp/pool';
import { GatewayServer } from '../src/server/gateway';

const ROOT = resolve(import.meta.dir, '..');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'image-server.ts');
const PORT = 19095;
const BASE = `http://127.0.0.1:${PORT}`;

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_BYTES = Buffer.from(PNG, 'base64');
const DATA_URI = `data:image/png;base64,${PNG}`;

describe('图像兼容整形（三态协商，HTTP 集成）', () => {
    test('inline / raw / 信封 / 服务开关 / 整形回落', async () => {
        const pool = new McpPool();
        await pool.addServer('img', { command: process.execPath, args: [FIXTURE], timeout: 15000 } as any);
        await pool.addServer('img_off', {
            command: process.execPath,
            args: [FIXTURE],
            timeout: 15000,
            owuiImageCompat: false,
        } as any);
        expect(pool.getSession('img')?.state).toBe('READY');

        const server = new GatewayServer(pool, { port: PORT, host: '127.0.0.1' });
        server.setPoolReady(true);
        server.start();
        onTestFinished(() => {
            server.stop();
            void pool.shutdown();
        });

        const call = (tool: string, headers: Record<string, string> = {}) =>
            fetch(`${BASE}/img/${tool}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: '{}'
            });

        // 1. 默认 inline：裸 data: URI 字符串
        const inline = await call('shot');
        expect(inline.headers.get('content-type')).toContain('text/plain');
        expect(await inline.text()).toBe(DATA_URI);

        // 2a. Accept: image/* → 裸字节
        const raw = await call('shot', { Accept: 'image/png' });
        expect(raw.headers.get('content-type')).toBe('image/png');
        expect(Buffer.from(await raw.arrayBuffer()).equals(PNG_BYTES)).toBe(true);

        // 2b. Accept: application/json → 信封（逃生口）
        const envelope = await call('shot', { Accept: 'application/json' });
        expect(envelope.headers.get('content-type')).toContain('application/json');
        const envelopeBody = (await envelope.json()) as any;
        expect(envelopeBody.content[0].type).toBe('image');

        // 2c. 服务级开关 owuiImageCompat: false → 恒信封
        const offCall = await fetch(`${BASE}/img_off/shot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        expect(offCall.headers.get('content-type')).toContain('application/json');
        const offBody = (await offCall.json()) as any;
        expect(offBody.content[0].type).toBe('image');

        // 3. 回落：多图像块 / 纯文本 / isError
        for (const tool of ['shot_multi', 'text_only', 'shot_err'] as const) {
            const resp = await call(tool);
            expect(resp.headers.get('content-type')).toContain('application/json');
            const body = (await resp.json()) as any;
            expect(Array.isArray(body.content)).toBe(true);
        }
    }, 30000);
});
