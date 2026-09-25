// OWUI 图像整形（服务级开关 + 三态协商）HTTP 集成测试：真实 GatewayServer + 图像夹具节点。
// 覆盖契约（方案 B）：
//   1. 默认（attach）：单图像块结果 → 裸 data: URI 字符串（text/plain）；
//      OWUI 会话头 + owui 配置齐备时双写副作用：文件上传 + files 事件挂 message.files
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
const MOCK_PORT = 19096;

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_BYTES = Buffer.from(PNG, 'base64');
const DATA_URI = `data:image/png;base64,${PNG}`;

// OWUI API 仿真：捕获文件上传与消息附件事件，返回可控响应。
interface MockCall {
    path: string;
    auth: string | null;
    body: unknown;
}
function startMockOwui(): { calls: MockCall[]; stop: () => void } {
    const calls: MockCall[] = [];
    const server = Bun.serve({
        port: MOCK_PORT,
        hostname: '127.0.0.1',
        fetch: async (req: Request) => {
            const url = new URL(req.url);
            const auth = req.headers.get('authorization');
            if (req.method === 'POST' && url.pathname === '/api/v1/files/') {
                calls.push({ path: url.pathname, auth, body: null });
                return Response.json({ id: 'file-abc123', filename: 'shot.png' });
            }
            if (req.method === 'POST' && /\/event$/.test(url.pathname)) {
                calls.push({ path: url.pathname, auth, body: await req.json() });
                return Response.json(true);
            }
            return Response.json({ error: 'not found' }, { status: 404 });
        },
    });
    return { calls, stop: () => server.stop(true) };
}

describe('OWUI 图像兼容整形（三态协商，HTTP 集成）', () => {
    test('attach 裸 data: URI / OWUI 双写副作用 / raw / 信封 / 回落全链路', async () => {
        const mock = startMockOwui();
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
        server.setOwuiConfig({ base: `http://127.0.0.1:${MOCK_PORT}`, token: 'test-token' });
        server.start();
        onTestFinished(() => {
            server.stop();
            mock.stop();
            void pool.shutdown();
        });

        const call = (tool: string, headers: Record<string, string> = {}) =>
            fetch(`${BASE}/img/${tool}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: '{}'
            });

        // 1a. 无 OWUI 会话头：默认 attach 整形为裸 data: URI 字符串，无副作用
        const attachBare = await call('shot');
        expect(attachBare.headers.get('content-type')).toContain('text/plain');
        expect(await attachBare.text()).toBe(DATA_URI);
        expect(mock.calls.length).toBe(0);

        // 1b. OWUI 会话头齐备：双写副作用（上传 + files 事件挂 message.files）
        const attach = await call('shot', {
            'X-OpenWebUI-Chat-Id': 'chat-1',
            'X-OpenWebUI-Message-Id': 'msg-1',
        });
        expect(await attach.text()).toBe(DATA_URI);
        expect(mock.calls.length).toBe(2);
        const upload = mock.calls[0];
        expect(upload.path).toBe('/api/v1/files/');
        expect(upload.auth).toBe('Bearer test-token');
        const event = mock.calls[1];
        expect(event.path).toBe('/api/v1/chats/chat-1/messages/msg-1/event');
        expect(event.auth).toBe('Bearer test-token');
        const eventBody = event.body as any;
        expect(eventBody.type).toBe('files');
        const fileEntry = eventBody.data.files[0];
        expect(fileEntry.type).toBe('image');
        expect(fileEntry.url).toBe('/api/v1/files/file-abc123/content');
        expect(fileEntry.name).toBe('shot.png');
        expect(fileEntry.content_type).toBe('image/png');

        // 2a. Accept: image/* → 裸字节
        const raw = await call('shot', { Accept: 'image/png' });
        expect(raw.headers.get('content-type')).toBe('image/png');
        expect(Buffer.from(await raw.arrayBuffer()).equals(PNG_BYTES)).toBe(true);

        // 2b. Accept: application/json → 信封（逃生口）
        const envelope = await call('shot', { Accept: 'application/json' });
        expect(envelope.headers.get('content-type')).toContain('application/json');
        const envelopeBody = (await envelope.json()) as any;
        expect(envelopeBody.content[0].type).toBe('image');

        // 2c. 服务级开关 owuiImageCompat: false → 恒信封，且无副作用
        const offCall = await fetch(`${BASE}/img_off/shot`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-OpenWebUI-Chat-Id': 'chat-1',
                'X-OpenWebUI-Message-Id': 'msg-1',
            },
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
