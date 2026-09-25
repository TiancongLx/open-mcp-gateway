// OWUI 图像整形（服务级开关 + 内容协商）集成测试：起真实 GatewayServer + 图像夹具节点，走 HTTP 断言响应形态。
// 覆盖契约：
//   1. 默认（开关开 + 未显式协商）：单图像块结果 → 200 + image/png 裸字节 + inline 头（auto 语义）
//   2. 显式 Accept: application/json → 200 + JSON CallToolResult 信封（程序化消费者逃生口）
//   3. 整形不适用（多图像块 / 纯文本 / isError）→ 一律回落 JSON 信封
//   4. 字节级保真：裸字节与夹具 base64 解码结果一致；历史别名头 X-OMG-Compat 保持生效
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

describe('OWUI 图像兼容整形（HTTP 集成）', () => {
    test('auto 出图 / JSON 逃生口 / 回落 / 字节保全全链路', async () => {
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

        // 1. 默认 auto：裸图像字节（含 Accept: */* 与无头两种形态）
        for (const headers of [{}, { Accept: '*/*' }] as const) {
            const shaped = await call('shot', headers as Record<string, string>);
            expect(shaped.status).toBe(200);
            expect(shaped.headers.get('content-type')).toBe('image/png');
            expect(shaped.headers.get('content-disposition')).toContain('inline');
            expect(shaped.headers.get('content-disposition')).toContain('shot.png');
            const shapedBytes = Buffer.from(await shaped.arrayBuffer());
            expect(shapedBytes.equals(PNG_BYTES)).toBe(true);
            expect(Array.from(shapedBytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
        }

        // 1b. 历史别名头保持生效
        const byAlias = await call('shot', { 'X-OMG-Compat': 'owui-image' });
        expect(byAlias.headers.get('content-type')).toBe('image/png');

        // 2. 显式 Accept: application/json → JSON 信封（逃生口）
        const envelope = await call('shot', { Accept: 'application/json' });
        expect(envelope.headers.get('content-type')).toContain('application/json');
        const envelopeBody = (await envelope.json()) as any;
        expect(envelopeBody.content[0].type).toBe('image');

        // 3. 回落：多图像块 / 纯文本 / isError
        for (const tool of ['shot_multi', 'text_only', 'shot_err'] as const) {
            const resp = await call(tool);
            expect(resp.headers.get('content-type')).toContain('application/json');
            const body = (await resp.json()) as any;
            expect(Array.isArray(body.content)).toBe(true);
        }
    }, 30000);
});
