// OWUI 图像整形（内容协商）集成测试：起真实 GatewayServer + 图像夹具节点，走 HTTP 断言响应形态。
// 覆盖四条契约：
//   1. 默认（无协商头 / Accept: */*）：200 + application/json CallToolResult 信封（现状行为不变）
//   2. X-OMG-Compat: owui-image 或 Accept: image/*：单图像块结果 → 200 + image/png 裸字节 + inline 头
//   3. 整形不适用（多图像块 / 纯文本 / isError）→ 一律回落 JSON 信封
//   4. 字节级保真：裸字节与夹具 base64 解码结果一致
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

describe('OWUI 图像兼容整形（内容协商，HTTP 集成）', () => {
    test('协商/回落/字节保全全链路', async () => {
        const pool = new McpPool();
        await pool.addServer('img', { command: process.execPath, args: [FIXTURE], timeout: 15000 } as any);
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

        // 1. 默认信封（不带协商头）
        const plain = await call('shot');
        const plainBody = (await plain.json()) as any;
        expect(plain.status).toBe(200);
        expect(plain.headers.get('content-type')).toContain('application/json');
        expect(plainBody.content[0].type).toBe('image');

        // Accept: */*（OWUI/aiohttp 默认）不触发整形
        const starAccept = await call('shot', { Accept: '*/*' });
        expect(starAccept.headers.get('content-type')).toContain('application/json');

        // 2a. X-OMG-Compat: owui-image → 裸图像字节
        const shaped = await call('shot', { 'X-OMG-Compat': 'owui-image' });
        expect(shaped.status).toBe(200);
        expect(shaped.headers.get('content-type')).toBe('image/png');
        expect(shaped.headers.get('content-disposition')).toContain('inline');
        expect(shaped.headers.get('content-disposition')).toContain('shot.png');
        const shapedBytes = Buffer.from(await shaped.arrayBuffer());
        expect(shapedBytes.equals(PNG_BYTES)).toBe(true);
        expect(Array.from(shapedBytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);

        // 2b. Accept: image/* 同样触发
        const byAccept = await call('shot', { Accept: 'image/png' });
        expect(byAccept.headers.get('content-type')).toBe('image/png');

        // 3. 回落：多图像块 / 纯文本 / isError
        for (const [tool, header] of [
            ['shot_multi', { 'X-OMG-Compat': 'owui-image' }],
            ['text_only', { 'X-OMG-Compat': 'owui-image' }],
            ['shot_err', { 'X-OMG-Compat': 'owui-image' }]
        ] as const) {
            const resp = await call(tool, header as Record<string, string>);
            expect(resp.headers.get('content-type')).toContain('application/json');
            const body = (await resp.json()) as any;
            expect(Array.isArray(body.content)).toBe(true);
        }
    }, 30000);
});
