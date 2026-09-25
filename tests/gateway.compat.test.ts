// OWUI 图像整形（服务级开关 + 三态协商）HTTP 集成测试：真实 GatewayServer + 图像夹具节点。
// 覆盖契约：
//   1. 默认（media）：单图像块结果 → {screenshot, render} 描述符；GET 截图 URL → 裸图像字节
//   2. Accept: image/* → 裸图像字节；Accept: application/json → JSON 信封（逃生口）
//   3. 整形不适用（多图像块 / 纯文本 / isError）→ JSON 信封
//   4. 媒体路由安全：未知/穿越文件名 → 404
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

describe('OWUI 图像兼容整形（三态协商，HTTP 集成）', () => {
    test('media 描述符 / 媒体回源 / raw / 信封 / 回落全链路', async () => {
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

        // 1. 默认 media：描述符（含 dataUri 供侧车免取图注入）+ 截图 URL 回源字节保全
        const media = await call('shot');
        expect(media.headers.get('content-type')).toContain('application/json');
        const desc = (await media.json()) as any;
        expect(desc.screenshot).toContain('/media/');
        expect(desc.render).toContain('![');
        expect(String(desc.dataUri)).toMatch(/^data:image\/png;base64,/);
        expect(Buffer.from(String(desc.dataUri).split(',')[1], 'base64').equals(PNG_BYTES)).toBe(true);
        const imgResp = await fetch(desc.screenshot);
        expect(imgResp.status).toBe(200);
        expect(imgResp.headers.get('content-type')).toBe('image/png');
        const imgBytes = Buffer.from(await imgResp.arrayBuffer());
        expect(imgBytes.equals(PNG_BYTES)).toBe(true);

        // 2a. Accept: image/* → 裸字节
        const raw = await call('shot', { Accept: 'image/png' });
        expect(raw.headers.get('content-type')).toBe('image/png');
        expect(Buffer.from(await raw.arrayBuffer()).equals(PNG_BYTES)).toBe(true);

        // 2b. Accept: application/json → 信封（逃生口）
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

        // 4. 媒体路由安全：未知与穿越文件名 → 404
        const missing = await fetch(`${BASE}/media/nonexistent-abc123.png`);
        expect(missing.status).toBe(404);
        const traversal = await fetch(`${BASE}/media/..%2F..%2Fetc%2Fpasswd`);
        expect(traversal.status).toBe(404);
    }, 30000);
});
