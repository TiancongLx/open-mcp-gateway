// 统一目录入口（/omg）HTTP 集成测试：真实 GatewayServer + 目录夹具 ×2 + 图像夹具 + 慢握手节点。
// 覆盖契约（决策 24）：
//   1. GET /omg 与 /omg/openapi.json：规格结构（search_tools / call_tool、manifest 清单、servers.url）
//   2. POST /omg/tools/search：精确名 / 关键词（含 CJK）/ unavailable_servers / 参数校验
//   3. POST /omg/tools/call：跨池分发、server 消歧、歧义 400、未知 400（候选提示）、未知服务器 404、未就绪 503（Retry-After）
//   4. 图像三态协商在 /omg/tools/call 上复用（inline data: URI / raw / 信封）
import { describe, test, expect, onTestFinished } from 'bun:test';
import { join, resolve } from 'node:path';
import { McpPool } from '../src/mcp/pool';
import { GatewayServer } from '../src/server/gateway';

const ROOT = resolve(import.meta.dir, '..');
const CATALOG_FIXTURE = join(ROOT, 'tests', 'fixtures', 'catalog-server.ts');
const IMAGE_FIXTURE = join(ROOT, 'tests', 'fixtures', 'image-server.ts');
const SLOW_FIXTURE = join(ROOT, 'tests', 'fixtures', 'slow-handshake-server.mjs');
const PORT = 19097;
const BASE = `http://127.0.0.1:${PORT}`;

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_BYTES = Buffer.from(PNG, 'base64');
const DATA_URI = `data:image/png;base64,${PNG}`;

type TransportLike = { _process?: { pid?: number }; process?: { pid?: number } } | null;

function stdioPidOf(session: unknown): number | undefined {
    const t = (session as { transport?: TransportLike })?.transport;
    return t?._process?.pid ?? t?.process?.pid;
}

describe('统一目录入口（/omg，HTTP 集成）', () => {
    test('规格 / 检索 / 分发 / 消歧 / 错误面 / 图像协商', async () => {
        const pool = new McpPool();
        await pool.addServer('catalog', { command: process.execPath, args: [CATALOG_FIXTURE], timeout: 15000 } as any);
        await pool.addServer('catalog2', { command: process.execPath, args: [CATALOG_FIXTURE], timeout: 15000 } as any);
        await pool.addServer('img', { command: process.execPath, args: [IMAGE_FIXTURE], timeout: 15000 } as any);
        const slowInit = pool.initialize({
            mcpServers: { slow: { command: process.execPath, args: [SLOW_FIXTURE], timeout: 60000 } },
        } as any);
        slowInit.catch(() => {
            // 握手终止异常由此路径兜底；initialize 内部经 allSettled 收敛
        });

        // 等待 slow 进入握手挂起（CONNECTING）
        let spins = 0;
        while ((!pool.hasInFlightConnections || pool.getSession('slow')?.state !== 'CONNECTING') && spins < 200) {
            await new Promise((r) => setTimeout(r, 25));
            spins++;
        }
        expect(pool.getSession('slow')?.state).toBe('CONNECTING');

        const slowPid = stdioPidOf(pool.getSession('slow'));
        const server = new GatewayServer(pool, { port: PORT, host: '127.0.0.1' });
        server.setPoolReady(true);
        server.start();
        onTestFinished(async () => {
            server.stop();
            await pool.shutdown();
            await slowInit;
            if (slowPid) {
                try {
                    Bun.spawnSync(['taskkill', '/F', '/T', '/PID', String(slowPid)]);
                } catch {
                    // 进程可能已随 abort 路径退出
                }
            }
        });

        const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
            fetch(`${BASE}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify(body),
            });

        // ---- 1. 规格 ----
        const specResp = await fetch(`${BASE}/omg/openapi.json`);
        expect(specResp.status).toBe(200);
        const spec = (await specResp.json()) as any;
        expect(spec.openapi).toBe('3.1.0');
        expect(spec.servers[0].url).toBe(`${BASE}/omg`);
        expect(spec.paths['/tools/search'].post.operationId).toBe('search_tools');
        expect(spec.paths['/tools/call'].post.operationId).toBe('call_tool');
        const searchDesc: string = spec.paths['/tools/search'].post.description;
        expect(searchDesc).toContain('read_doc');
        expect(searchDesc).toContain('shot');
        expect(searchDesc).not.toContain('slow');

        const specResp2 = await fetch(`${BASE}/omg`);
        expect(specResp2.status).toBe(200);
        const spec2 = (await specResp2.json()) as any;
        expect(spec2.paths['/tools/call'].post.operationId).toBe('call_tool');

        // ---- 2. 检索 ----
        const exact = await post('/omg/tools/search', { query: 'read_doc' });
        expect(exact.status).toBe(200);
        const exactBody = (await exact.json()) as any;
        expect(exactBody.tools.map((t: any) => `${t.server}:${t.name}`)).toEqual(['catalog:read_doc', 'catalog2:read_doc']);
        expect(exactBody.tools[0].input_schema.properties.path.type).toBe('string');
        expect(exactBody.unavailable_servers).toEqual(['slow']);

        const cjk = await post('/omg/tools/search', { query: '文档' });
        const cjkBody = (await cjk.json()) as any;
        expect(cjkBody.tools.map((t: any) => t.name)).toContain('read_doc');

        const camel = await post('/omg/tools/search', { query: 'items' });
        const camelBody = (await camel.json()) as any;
        expect(camelBody.tools.map((t: any) => t.name)).toContain('listItems');

        expect((await post('/omg/tools/search', {})).status).toBe(400);
        expect((await post('/omg/tools/search', { query: 'x', count: 'five' })).status).toBe(400);

        // ---- 2b. 服务枚举与作用域检索（人机工程迭代）----
        const enumAll = await post('/omg/tools/search', { server: 'catalog' });
        expect(enumAll.status).toBe(200);
        const enumAllBody = (await enumAll.json()) as any;
        expect(enumAllBody.tools.map((t: any) => t.name)).toEqual(['doc_stats', 'echo_args', 'fail_always', 'listItems', 'read_doc']);
        expect(typeof enumAllBody.generated_at).toBe('string');

        const enumCapped = await post('/omg/tools/search', { server: 'catalog', count: 2 });
        expect(((await enumCapped.json()) as any).tools.map((t: any) => t.name)).toEqual(['doc_stats', 'echo_args']);

        const enumByName = await post('/omg/tools/search', { query: 'catalog' });
        const enumByNameBody = (await enumByName.json()) as any;
        expect(new Set(enumByNameBody.tools.map((t: any) => t.server))).toEqual(new Set(['catalog']));
        expect(enumByNameBody.tools.length).toBe(5);

        const scopedSearch = await post('/omg/tools/search', { query: 'read', server: 'catalog2' });
        const scopedBody = (await scopedSearch.json()) as any;
        expect(scopedBody.tools.length).toBeGreaterThan(0);
        expect(scopedBody.tools.every((t: any) => t.server === 'catalog2')).toBe(true);

        expect((await post('/omg/tools/search', { server: 'ghost' })).status).toBe(404);
        expect((await post('/omg/tools/search', { server: 'slow' })).status).toBe(503);
        expect((await post('/omg/tools/search', { query: 123 })).status).toBe(400);

        const zeroHit = await post('/omg/tools/search', { query: 'zzzz_nomatch' });
        const zeroBody = (await zeroHit.json()) as any;
        expect(zeroBody.tools).toEqual([]);
        expect(typeof zeroBody.hint).toBe('string');

        // ---- 3. 调用：分发 / 参数透传 / 上下文透传 ----
        const call = await post('/omg/tools/call', { tool: 'read_doc', server: 'catalog', arguments: { path: 'x.md' } });
        expect(call.status).toBe(200);
        const callBody = (await call.json()) as any;
        expect(callBody.content[0].text).toBe('doc:x.md');

        const nullArgs = await post('/omg/tools/call', { tool: 'read_doc', server: 'catalog', arguments: null });
        expect(nullArgs.status).toBe(200);

        const ctx = await post(
            '/omg/tools/call',
            { tool: 'echo_args', server: 'catalog', arguments: { anything: 'a' } },
            { 'X-Tool-Context-Chat-Id': 'chat-123' }
        );
        expect(ctx.status).toBe(200);
        const ctxText = ((await ctx.json()) as any).content[0].text as string;
        const ctxArgs = JSON.parse(ctxText) as Record<string, unknown>;
        expect(ctxArgs.anything).toBe('a');
        expect(ctxArgs.chat_id).toBe('chat-123');

        // ---- 3b. 歧义 / 消歧 ----
        const ambiguous = await post('/omg/tools/call', { tool: 'read_doc' });
        expect(ambiguous.status).toBe(400);
        const ambBody = (await ambiguous.json()) as any;
        expect(ambBody.candidates.map((c: any) => c.server)).toEqual(['catalog', 'catalog2']);

        const scoped = await post('/omg/tools/call', { tool: 'read_doc', server: 'catalog2', arguments: { path: 'y' } });
        expect(scoped.status).toBe(200);
        expect(((await scoped.json()) as any).content[0].text).toBe('doc:y');

        // ---- 3c. 错误面 ----
        const unknownTool = await post('/omg/tools/call', { tool: 'zzz_nonexistent' });
        expect(unknownTool.status).toBe(400);
        expect(Array.isArray(((await unknownTool.json()) as any).suggestions)).toBe(true);

        const wrongServerTool = await post('/omg/tools/call', { tool: 'read_doc', server: 'img' });
        expect(wrongServerTool.status).toBe(400);

        const ghost = await post('/omg/tools/call', { tool: 'read_doc', server: 'ghost' });
        expect(ghost.status).toBe(404);

        const notReady = await post('/omg/tools/call', { tool: 'whatever', server: 'slow' });
        expect(notReady.status).toBe(503);
        const nrBody = (await notReady.json()) as any;
        expect(nrBody.state).toBe('CONNECTING');
        expect(notReady.headers.get('retry-after')).toBe('2');

        // ---- 3d. 失败结果附挂 input_schema（人机工程迭代）----
        const failCall = await post('/omg/tools/call', { tool: 'fail_always', server: 'catalog' });
        expect(failCall.status).toBe(200);
        const failBody = (await failCall.json()) as any;
        expect(failBody.isError).toBe(true);
        const failText = failBody.content.map((c: any) => c.text ?? '').join('\n');
        expect(failText).toContain('input_schema');
        expect(failText).toContain('demo_arg');

        // ---- 4. 图像协商（目录调用 img/shot）----
        const imgInline = await post('/omg/tools/call', { tool: 'shot', server: 'img' });
        expect(imgInline.headers.get('content-type')).toContain('text/plain');
        expect(await imgInline.text()).toBe(DATA_URI);

        const imgRaw = await post('/omg/tools/call', { tool: 'shot', server: 'img' }, { Accept: 'image/png' });
        expect(imgRaw.headers.get('content-type')).toBe('image/png');
        expect(Buffer.from(await imgRaw.arrayBuffer()).equals(PNG_BYTES)).toBe(true);

        const imgEnvelope = await post('/omg/tools/call', { tool: 'shot', server: 'img' }, { Accept: 'application/json' });
        expect(((await imgEnvelope.json()) as any).content[0].type).toBe('image');

        // ---- 5. 方法面 ----
        expect((await fetch(`${BASE}/omg/tools/search`, { method: 'GET' })).status).toBe(405);
        expect((await fetch(`${BASE}/omg`, { method: 'POST' })).status).toBe(405);
    }, 60000);
});
