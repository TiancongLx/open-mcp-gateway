// Streamable HTTP MCP 测试夹具（S1 批次）：Bun.serve + WebStandardStreamableHTTPServerTransport（stateless）。
// stateless 约定（SDK 1.30）：每请求新建 transport + Server 绑定（禁止跨请求复用同一 transport，
// 见 webStandardStreamableHttp.js「Stateless transport cannot be reused across requests」守卫）。
// 控制面（独立端口，故障期不离线）：
//   GET  /health            → { status: 'ok', outage }
//   POST /outage?mode=start → 停掉 MCP 监听（真实拒连，模拟链路中断）
//   POST /outage?mode=stop  → 恢复 MCP 监听
// 认证面：FIXTURE_REQUIRE_AUTH=1 时 /mcp 全部请求要求 Bearer fixture-token。
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const PORT = Number(process.env.FIXTURE_PORT ?? '19111');
const CONTROL_PORT = Number(process.env.FIXTURE_CONTROL_PORT ?? String(PORT + 1));
const REQUIRE_AUTH = process.env.FIXTURE_REQUIRE_AUTH === '1';

let outage = false;
let mcpServer: ReturnType<typeof Bun.serve> | null = null;

function buildServer(): Server {
    const server = new Server({ name: 'streamable-fixture', version: '0.0.1' }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            { name: 'http_ping', description: 'streamable fixture ping', inputSchema: { type: 'object', properties: {} } },
            {
                name: 'http_echo',
                description: 'echo received arguments back as JSON text',
                inputSchema: { type: 'object', properties: { anything: { type: 'string' } } },
            },
        ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const name = req.params.name;
        const args = (req.params.arguments ?? {}) as Record<string, unknown>;
        const text = name === 'http_ping' ? 'pong' : JSON.stringify(args);
        return { content: [{ type: 'text', text }] };
    });

    return server;
}

function handleMcp(req: Request): Response | Promise<Response> {
    if (REQUIRE_AUTH && req.headers.get('authorization') !== 'Bearer fixture-token') {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
        // 无服务器推送流 / 无会话状态：按规范以 405 礼貌拒绝（客户端应优雅降级）
        return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    }
    // stateless：每请求新建 Server + transport 绑定
    const server = buildServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    return server.connect(transport).then(() => transport.handleRequest(req));
}

function startMcpServer(): void {
    mcpServer = Bun.serve({
        hostname: '127.0.0.1',
        port: PORT,
        async fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === '/mcp') {
                console.log(`[fixture] ${req.method} /mcp accept=${req.headers.get('accept') ?? '-'} sid=${req.headers.get('mcp-session-id') ?? '-'}`);
                try {
                    return await handleMcp(req);
                } catch (err) {
                    console.error('[fixture] /mcp handler error:', err);
                    return Response.json({ error: String(err) }, { status: 500 });
                }
            }
            return new Response('not found', { status: 404 });
        },
    });
}

async function resumeMcpServer(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        try {
            startMcpServer();
            return;
        } catch {
            await Bun.sleep(50);
        }
    }
    throw new Error('resume mcp server failed');
}

startMcpServer();

Bun.serve({
    hostname: '127.0.0.1',
    port: CONTROL_PORT,
    async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/health') {
            return Response.json({ status: 'ok', outage });
        }
        if (url.pathname === '/outage' && req.method === 'POST') {
            const mode = url.searchParams.get('mode');
            if (mode === 'start' && !outage) {
                outage = true;
                mcpServer?.stop(true);
                mcpServer = null;
            } else if (mode === 'stop' && outage) {
                await resumeMcpServer();
                outage = false;
            }
            return Response.json({ outage });
        }
        return new Response('not found', { status: 404 });
    },
});

console.log(`streamable fixture: mcp=${PORT} control=${CONTROL_PORT}`);
