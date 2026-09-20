import { info, error, warn } from '@/utils/logger';
import { McpPool } from '@/mcp/pool';
import { OpenApiGenerator } from '@/openapi/generator';

export interface GatewayServerOptions {
    port: number;
    host: string;
}

export class GatewayServer {
    private server: ReturnType<typeof Bun.serve> | null = null;
    private isPoolReady = false;

    constructor(
        private readonly pool: McpPool,
        private readonly options: GatewayServerOptions
    ) {}

    public setPoolReady(ready: boolean): void {
        this.isPoolReady = ready;
    }

    private resolvePublicOrigin(req: Request): string {
        const proto = req.headers.get('x-forwarded-proto') || 'http';
        const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || `${this.options.host}:${this.options.port}`;
        const prefix = req.headers.get('x-forwarded-prefix') || '';
        return `${proto}://${host}${prefix}`.replace(/\/+$/, '');
    }

    public start(): void {
        const { port, host } = this.options;

        this.server = Bun.serve({
            port,
            hostname: host,
            fetch: async (req: Request) => {
                const url = new URL(req.url);
                const path = url.pathname;
                const method = req.method.toUpperCase();

                const corsHeaders = {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Forwarded-Host, X-Forwarded-Proto',
                };

                if (method === 'OPTIONS') {
                    return new Response(null, { status: 204, headers: corsHeaders });
                }

                try {
                    info(`[HTTP] ${method} ${path}`);

                    // 1. 就绪探针
                    if (path === '/health' && method === 'GET') {
                        return Response.json({
                            status: 'ok',
                            uptime: process.uptime(),
                            poolReady: this.isPoolReady,
                        }, { headers: corsHeaders });
                    }

                    // 2. 服务注册表查询
                    if (path === '/servers' && method === 'GET') {
                        const all = this.pool.getAllSessions();
                        const summary: Record<string, unknown> = {};
                        for (const [name, sess] of all.entries()) {
                            summary[name] = {
                                state: sess.state,
                                lastError: sess.lastError,
                                toolCount: sess.tools.size,
                                tools: Array.from(sess.tools.keys()),
                            };
                        }
                        return Response.json({ servers: summary }, { headers: corsHeaders });
                    }

                    const normalizedPath = path.replace(/\/+$/, '');
                    const publicOrigin = this.resolvePublicOrigin(req);

                    // 3. OpenAPI 规范端点
                    let openApiServerName: string | null = null;
                    const openApiMatch = normalizedPath.match(/^\/([^/]+)\/openapi\.json$/);
                    if (openApiMatch && method === 'GET') {
                        openApiServerName = openApiMatch[1];
                    } else {
                        const directMatch = normalizedPath.match(/^\/([^/]+)$/);
                        if (directMatch && method === 'GET') {
                            const candidate = directMatch[1];
                            if (candidate !== 'health' && candidate !== 'servers') {
                                openApiServerName = candidate;
                            }
                        }
                    }

                    if (openApiServerName) {
                        const session = this.pool.getSession(openApiServerName);
                        if (!session) {
                            warn(`[HTTP 404] 服务 [${openApiServerName}] 不存在`);
                            return Response.json({ error: `Server [${openApiServerName}] not found` }, { status: 404, headers: corsHeaders });
                        }

                        if (session.state !== 'READY') {
                            warn(`[HTTP 503] 服务 [${openApiServerName}] 尚未就绪 (当前状态: ${session.state})`);
                            return Response.json({
                                error: `Server [${openApiServerName}] not ready`,
                                state: session.state,
                                lastError: session.lastError,
                            }, {
                                status: 503,
                                headers: {
                                    ...corsHeaders,
                                    ...(session.state === 'CONNECTING' ? { 'Retry-After': '2' } : {}),
                                },
                            });
                        }

                        const spec = OpenApiGenerator.generate(session, publicOrigin);
                        return Response.json(spec, {
                            headers: {
                                ...corsHeaders,
                                'Content-Type': 'application/json; charset=utf-8',
                            },
                        });
                    }

                    // 4. 工具调用路由
                    let matchedServer: string | null = null;
                    let matchedTool: string | null = null;

                    const singleMatch = normalizedPath.match(/^\/([^/]+)\/([^/]+)$/);
                    const doubleMatch = normalizedPath.match(/^\/([^/]+)\/\1\/([^/]+)$/);

                    if (doubleMatch) {
                        matchedServer = doubleMatch[1];
                        matchedTool = doubleMatch[2];
                    } else if (singleMatch) {
                        matchedServer = singleMatch[1];
                        matchedTool = singleMatch[2];
                    }

                    if (matchedServer && matchedTool && method === 'POST') {
                        if (matchedTool === 'openapi.json') {
                            return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers: corsHeaders });
                        }

                        const session = this.pool.getSession(matchedServer);
                        if (!session) {
                            warn(`[HTTP 404] 服务 [${matchedServer}] 未注册`);
                            return Response.json({ error: `Server [${matchedServer}] not found` }, { status: 404, headers: corsHeaders });
                        }

                        if (session.state !== 'READY') {
                            warn(`[HTTP 503] 服务 [${matchedServer}] 未就绪 (当前状态: ${session.state})`);
                            return Response.json({
                                error: `Server [${matchedServer}] not ready`,
                                state: session.state,
                                lastError: session.lastError,
                            }, {
                                status: 503,
                                headers: {
                                    ...corsHeaders,
                                    ...(session.state === 'CONNECTING' ? { 'Retry-After': '2' } : {}),
                                },
                            });
                        }

                        let body: Record<string, unknown> = {};
                        try {
                            const rawText = await req.text();
                            if (rawText.trim().length > 0) {
                                body = JSON.parse(rawText);
                            }
                        } catch {
                            return Response.json({ error: 'Invalid JSON request payload' }, { status: 400, headers: corsHeaders });
                        }

                        info(`[工具执行] 服务: [${matchedServer}], 工具: [${matchedTool}]`);
                        const executionResult = await session.callTool(matchedTool, body);

                        return Response.json(executionResult, {
                            headers: {
                                ...corsHeaders,
                                'Content-Type': 'application/json; charset=utf-8',
                            },
                        });
                    }

                    warn(`[HTTP 404] 路由未匹配: ${method} ${path}`);
                    return Response.json({ error: 'Not Found' }, { status: 404, headers: corsHeaders });
                } catch (err) {
                    error(`[HTTP 500] 处理异常: ${err instanceof Error ? err.message : String(err)}`);
                    return Response.json({
                        error: 'Gateway Error',
                        message: err instanceof Error ? err.message : String(err),
                    }, { status: 500, headers: corsHeaders });
                }
            },
        });

        info(`mcp-gateway 已成功监听在: http://${host}:${port}`);
    }

    public stop(): void {
        if (this.server) {
            this.server.stop(true);
            this.server = null;
            info('HTTP 监听网关已安全停机');
        }
    }
}
