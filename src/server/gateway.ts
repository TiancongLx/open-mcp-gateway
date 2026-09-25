import { info, error, warn } from '@/utils/logger';
import { McpPool } from '@/mcp/pool';
import { OpenApiGenerator } from '@/openapi/generator';
import { isImageCompatEnabled, resolveImageMode, shapeImageResult } from '@/server/image-shape';
import { attachImageToOwuiMessage, resolveAttachTarget, type OwuiAttachConfig } from '@/server/owui-attach';

export interface GatewayServerOptions {
    port: number;
    host: string;
}

export class GatewayServer {
    private server: ReturnType<typeof Bun.serve> | null = null;
    private isPoolReady = false;
    private owuiConfig: OwuiAttachConfig | null = null;

    constructor(
        private readonly pool: McpPool,
        private readonly options: GatewayServerOptions
    ) {}

    public setPoolReady(ready: boolean): void {
        this.isPoolReady = ready;
    }

    // OWUI 直写配置（attach 副作用目标）：随 config 热重载更新；base/token 任一缺失即视为未配置。
    public setOwuiConfig(config: OwuiAttachConfig | null | undefined): void {
        this.owuiConfig = config && config.base && config.token ? config : null;
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
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Forwarded-Host, X-Forwarded-Proto, X-OMG-Compat, Accept',
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

                        // OWUI 兼容整形（服务级开关 + 三态内容协商，见 image-shape.ts）：
                        //   attach（缺省）= 裸 data: URI 字符串：OWUI 将其分流为
                        //     input_image（同轮喂模型），网关同步副作用把同一图像挂入
                        //     message.files 补用户展示（owui-attach.ts 双写语义）；
                        //   raw（Accept 显式 image/*）= 裸图像字节；
                        //   envelope（开关关 / 显式 Accept: application/json / 整形不适用）
                        //     = CallToolResult JSON 信封。
                        const imageMode = resolveImageMode(req.headers, isImageCompatEnabled(session.config));
                        if (imageMode !== 'envelope') {
                            const shaped = shapeImageResult(executionResult, matchedTool);
                            if (shaped) {
                                if (imageMode === 'raw') {
                                    info(`[工具执行] 图像整形(raw): [${matchedServer}/${matchedTool}] ${shaped.mimeType} ${shaped.bytes.byteLength}B`);
                                    return new Response(shaped.bytes, {
                                        headers: {
                                            ...corsHeaders,
                                            'Content-Type': shaped.mimeType,
                                            'Content-Disposition': `inline; filename="${shaped.filename}"`,
                                        },
                                    });
                                }
                                const dataUri = `data:${shaped.mimeType};base64,${Buffer.from(shaped.bytes).toString('base64')}`;
                                const target = resolveAttachTarget(req.headers);
                                if (this.owuiConfig && target) {
                                    const fileUrl = await attachImageToOwuiMessage(this.owuiConfig, target, shaped);
                                    info(`[工具执行] 图像直写(attach): [${matchedServer}/${matchedTool}] ${fileUrl ?? '附件未挂载（仅同轮视觉）'} ${shaped.bytes.byteLength}B`);
                                } else {
                                    info(`[工具执行] 图像整形(attach, 无 OWUI 上下文): [${matchedServer}/${matchedTool}] ${shaped.bytes.byteLength}B`);
                                }
                                // text/plain：execute_tool_server 不做 JSON 解析，data: 串原样进
                                // process_tool_result → extract_base64_images → input_image。
                                return new Response(dataUri, {
                                    headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
                                });
                            }
                        }

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

        info(`open-mcp-gateway 已成功监听在: http://${host}:${port}`);
    }

    public stop(): void {
        if (this.server) {
            this.server.stop(true);
            this.server = null;
            info('HTTP 监听网关已安全停机');
        }
    }
}
