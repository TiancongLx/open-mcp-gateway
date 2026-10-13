import { info, error, warn } from '@/utils/logger';
import { McpPool } from '@/mcp/pool';
import { OpenApiGenerator } from '@/openapi/generator';
import {
    CATALOG_NAMESPACE,
    buildUnifiedSpec,
    collectPoolView,
    enumerateCatalog,
    resolveCallTarget,
    searchCatalog,
} from '@/openapi/catalog';
import { isImageCompatEnabled, resolveImageMode, shapeImageResult } from '@/server/image-shape';

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
            idleTimeout: 255, // 最大值（秒），避免 SSE 等流式响应被 10s 默认值截断
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
                        // enabled=false 的服务不建立会话，在注册表中保留 DISABLED 占位
                        for (const name of this.pool.getDisabledServers().keys()) {
                            if (!(name in summary)) {
                                summary[name] = {
                                    state: 'DISABLED',
                                    lastError: null,
                                    toolCount: 0,
                                    tools: [],
                                };
                            }
                        }
                        return Response.json({ servers: summary }, { headers: corsHeaders });
                    }

                    const normalizedPath = path.replace(/\/+$/, '');
                    const publicOrigin = this.resolvePublicOrigin(req);

                    // 3. 统一目录入口（保留命名空间 /omg，决策 24）
                    const catalogBase = `/${CATALOG_NAMESPACE}`;
                    if (normalizedPath === catalogBase || normalizedPath === `${catalogBase}/openapi.json`) {
                        if (method !== 'GET') {
                            return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers: corsHeaders });
                        }
                        this.warnCatalogNamespaceShadow();
                        const catalogSpec = buildUnifiedSpec(this.pool, publicOrigin);
                        return Response.json(catalogSpec, {
                            headers: {
                                ...corsHeaders,
                                'Content-Type': 'application/json; charset=utf-8',
                            },
                        });
                    }
                    if (normalizedPath === `${catalogBase}/tools/search` || normalizedPath === `${catalogBase}/tools/call`) {
                        if (method !== 'POST') {
                            return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers: corsHeaders });
                        }
                        this.warnCatalogNamespaceShadow();
                        return normalizedPath === `${catalogBase}/tools/search`
                            ? await this.handleCatalogSearch(req, corsHeaders)
                            : await this.handleCatalogCall(req, corsHeaders);
                    }

                    // 4. OpenAPI 规范端点
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
                            if (this.pool.getDisabledServers().has(openApiServerName)) {
                                warn(`[HTTP 503] 服务 [${openApiServerName}] 已禁用 (enabled=false)`);
                                return Response.json({
                                    error: `Server [${openApiServerName}] disabled`,
                                    state: 'DISABLED',
                                }, { status: 503, headers: corsHeaders });
                            }
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

                    // 5. 工具调用路由
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
                            if (this.pool.getDisabledServers().has(matchedServer)) {
                                warn(`[HTTP 503] 服务 [${matchedServer}] 已禁用 (enabled=false)`);
                                return Response.json({
                                    error: `Server [${matchedServer}] disabled`,
                                    state: 'DISABLED',
                                }, { status: 503, headers: corsHeaders });
                            }
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
                        // Tool context forwarding: inject chat-context headers as tool metadata
                        const toolCtxChatId = req.headers.get('X-Tool-Context-Chat-Id');
                        const toolCtxUserMsgId = req.headers.get('X-Tool-Context-User-Message-Id');
                        if (toolCtxChatId) body.chat_id = toolCtxChatId;
                        if (toolCtxUserMsgId) body.user_message_id = toolCtxUserMsgId;

                        const executionResult = await session.callTool(matchedTool, body);

                        // 图像兼容整形（服务级开关 + 三态内容协商，见 image-shape.ts）：
                        //   inline（缺省）= 裸 data: URI 字符串（text/plain），消费端
                        //     经 process_tool_result → extract_base64_images → input_image
                        //     同轮喂模型；
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
                                info(`[工具执行] 图像整形(inline): [${matchedServer}/${matchedTool}] ${shaped.bytes.byteLength}B`);
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

    // ---- 统一目录入口（/omg，决策 24）：检索 search_tools / 调度 call_tool ----

    private catalogShadowWarned = false;

    private warnCatalogNamespaceShadow(): void {
        if (this.catalogShadowWarned) return;
        if (this.pool.getSession(CATALOG_NAMESPACE) || this.pool.getDisabledServers().has(CATALOG_NAMESPACE)) {
            this.catalogShadowWarned = true;
            warn(`[${CATALOG_NAMESPACE}] 保留命名空间遮蔽了同名 MCP 服务：/${CATALOG_NAMESPACE} 路由优先`);
        }
    }

    private async parseJsonBody(req: Request): Promise<Record<string, unknown>> {
        const rawText = await req.text();
        if (rawText.trim().length === 0) {
            return {};
        }
        const parsed: unknown = JSON.parse(rawText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('payload is not a JSON object');
        }
        return parsed as Record<string, unknown>;
    }

    // 失败结果补挂 input_schema（人机工程迭代）：仅 isError 信封触发，成功路径零改动。
    private augmentErrorWithSchema(result: unknown, toolName: string, schema: unknown): unknown {
        if (!schema) return result;
        const rec = result as { isError?: unknown; content?: unknown } | null;
        if (!rec || typeof rec !== 'object' || rec.isError !== true || !Array.isArray(rec.content)) {
            return result;
        }
        return {
            ...(rec as Record<string, unknown>),
            content: [
                ...(rec.content as unknown[]),
                { type: 'text', text: `The call failed. Expected input_schema for ${toolName}: ${JSON.stringify(schema)}` },
            ],
        };
    }

    private async handleCatalogSearch(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
        let body: Record<string, unknown>;
        try {
            body = await this.parseJsonBody(req);
        } catch {
            return Response.json({ error: 'Invalid JSON request payload' }, { status: 400, headers: corsHeaders });
        }

        const { query, count, server } = body;
        let searchQuery = '';
        if (query !== undefined) {
            if (typeof query !== 'string') {
                return Response.json({ error: "'query' must be a string" }, { status: 400, headers: corsHeaders });
            }
            searchQuery = query.trim();
        }
        let searchServer: string | undefined;
        if (server !== undefined) {
            if (typeof server !== 'string') {
                return Response.json({ error: "'server' must be a string" }, { status: 400, headers: corsHeaders });
            }
            searchServer = server.trim() || undefined;
        }
        let searchCount: number | undefined;
        if (count === undefined) {
            searchCount = undefined;
        } else if (typeof count === 'number' && Number.isFinite(count)) {
            searchCount = count;
        } else {
            return Response.json({ error: "'count' must be a finite number" }, { status: 400, headers: corsHeaders });
        }
        if (!searchServer && !searchQuery) {
            return Response.json({ error: "Missing 'query' or 'server'" }, { status: 400, headers: corsHeaders });
        }

        const view = collectPoolView(this.pool);
        const entries = view.ready.flatMap((readyServer) => readyServer.tools);

        // 服务枚举解析：显式 server 参数（query 缺省即枚举）优先；查询词恰为某 READY 服务名时按枚举处理（便利语义）
        let scope = searchServer;
        if (!scope && searchQuery && view.ready.some((readyServer) => readyServer.server === searchQuery)) {
            scope = searchQuery;
            searchQuery = '';
        }
        if (scope && !view.ready.some((readyServer) => readyServer.server === scope)) {
            const session = this.pool.getSession(scope);
            if (session) {
                warn(`[目录检索 拒绝] 服务 [${scope}] 未就绪 (当前状态: ${session.state})`);
                return Response.json(
                    {
                        error: `Server [${scope}] not ready`,
                        state: session.state,
                        lastError: session.lastError,
                        unavailable_servers: view.unavailable,
                    },
                    {
                        status: 503,
                        headers: {
                            ...corsHeaders,
                            ...(session.state === 'CONNECTING' ? { 'Retry-After': '2' } : {}),
                        },
                    }
                );
            }
            if (this.pool.getDisabledServers().has(scope)) {
                warn(`[目录检索 拒绝] 服务 [${scope}] 已禁用 (enabled=false)`);
                return Response.json(
                    { error: `Server [${scope}] disabled`, state: 'DISABLED' },
                    { status: 503, headers: corsHeaders }
                );
            }
            return Response.json(
                {
                    error: `Server [${scope}] not found`,
                    available_servers: [...view.ready.map((readyServer) => readyServer.server), ...view.unavailable],
                },
                { status: 404, headers: corsHeaders }
            );
        }

        const hits = !scope
            ? searchCatalog(entries, searchQuery, searchCount)
            : searchQuery
                ? searchCatalog(entries, searchQuery, searchCount, scope)
                : enumerateCatalog(entries, scope, searchCount);

        const responseBody: Record<string, unknown> = {
            tools: hits,
            unavailable_servers: view.unavailable,
            generated_at: new Date().toISOString(),
        };
        // 服务指令保真（S2）：命中工具所属服务的 MCP instructions 按需附出（不常驻 spec / 系统提示）
        const hitServers = new Set(hits.map((hit) => hit.server));
        const serverInstructions: Record<string, string> = {};
        for (const readyServer of view.ready) {
            if (hitServers.has(readyServer.server) && readyServer.instructions) {
                serverInstructions[readyServer.server] = readyServer.instructions;
            }
        }
        if (Object.keys(serverInstructions).length > 0) {
            responseBody.server_instructions = serverInstructions;
        }
        if (hits.length === 0) {
            responseBody.hint = scope
                ? `No matches in server '${scope}'. Omit 'query' to enumerate all of its tools.`
                : "No matches. Pass 'server' to enumerate a server's tools, or use an exact tool name.";
        }

        info(
            `[目录检索] query=[${searchQuery}] server=[${scope ?? '-'}] hits=${hits.length} ready=${view.ready.length} unavailable=${view.unavailable.length}`
        );
        return Response.json(responseBody, {
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/json; charset=utf-8',
            },
        });
    }

    private async handleCatalogCall(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
        let body: Record<string, unknown>;
        try {
            body = await this.parseJsonBody(req);
        } catch {
            return Response.json({ error: 'Invalid JSON request payload' }, { status: 400, headers: corsHeaders });
        }

        const { tool, server, arguments: rawArguments } = body;
        if (typeof tool !== 'string' || tool.trim().length === 0) {
            return Response.json({ error: "Missing 'tool'" }, { status: 400, headers: corsHeaders });
        }
        let serverName: string | undefined;
        if (server !== undefined) {
            if (typeof server !== 'string') {
                return Response.json({ error: "'server' must be a string" }, { status: 400, headers: corsHeaders });
            }
            serverName = server.trim() || undefined;
        }
        let callArgs: Record<string, unknown> = {};
        if (rawArguments !== undefined && rawArguments !== null) {
            if (typeof rawArguments !== 'object' || Array.isArray(rawArguments)) {
                return Response.json({ error: "'arguments' must be a JSON object" }, { status: 400, headers: corsHeaders });
            }
            callArgs = { ...(rawArguments as Record<string, unknown>) };
        }

        // 工具上下文透传（与池路径一致：X-Tool-Context-* → chat_id / user_message_id）
        const toolCtxChatId = req.headers.get('X-Tool-Context-Chat-Id');
        const toolCtxUserMsgId = req.headers.get('X-Tool-Context-User-Message-Id');
        if (toolCtxChatId) callArgs.chat_id = toolCtxChatId;
        if (toolCtxUserMsgId) callArgs.user_message_id = toolCtxUserMsgId;

        const toolName = tool.trim();
        const resolved = resolveCallTarget(this.pool, toolName, serverName);
        if (resolved.kind === 'reject') {
            warn(`[目录调用 拒绝] ${resolved.status} tool=[${toolName}] server=[${serverName ?? '-'}]`);
            return Response.json(resolved.body, {
                status: resolved.status,
                headers: {
                    ...corsHeaders,
                    ...(resolved.retryAfter ? { 'Retry-After': resolved.retryAfter } : {}),
                },
            });
        }

        info(`[目录调用] 服务: [${resolved.server}], 工具: [${toolName}]`);
        let executionResult: unknown;
        try {
            executionResult = await resolved.session.callTool(toolName, callArgs);
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            warn(`[目录调用 异常] tool=[${toolName}] ${errMsg}`);
            const content: Array<Record<string, unknown>> = [{ type: 'text', text: `Tool call failed: ${errMsg}` }];
            const schema = resolved.session.tools.get(toolName)?.inputSchema;
            if (schema) {
                content.push({ type: 'text', text: `Expected input_schema for ${toolName}: ${JSON.stringify(schema)}` });
            }
            return Response.json({ isError: true, error: errMsg, content }, { status: 500, headers: corsHeaders });
        }
        // 失败信封补挂 schema（自修复不依赖重搜）；仅 isError 结果触发
        executionResult = this.augmentErrorWithSchema(executionResult, toolName, resolved.session.tools.get(toolName)?.inputSchema);

        // 图像三态协商复用（image-shape.ts）：inline 缺省 / raw / envelope
        const imageMode = resolveImageMode(req.headers, isImageCompatEnabled(resolved.session.config));
        if (imageMode !== 'envelope') {
            const shaped = shapeImageResult(executionResult, toolName);
            if (shaped) {
                if (imageMode === 'raw') {
                    info(`[目录调用] 图像整形(raw): [${resolved.server}/${toolName}] ${shaped.mimeType} ${shaped.bytes.byteLength}B`);
                    return new Response(shaped.bytes, {
                        headers: {
                            ...corsHeaders,
                            'Content-Type': shaped.mimeType,
                            'Content-Disposition': `inline; filename="${shaped.filename}"`,
                        },
                    });
                }
                const dataUri = `data:${shaped.mimeType};base64,${Buffer.from(shaped.bytes).toString('base64')}`;
                info(`[目录调用] 图像整形(inline): [${resolved.server}/${toolName}] ${shaped.bytes.byteLength}B`);
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

    public stop(): void {
        if (this.server) {
            this.server.stop(true);
            this.server = null;
            info('HTTP 监听网关已安全停机');
        }
    }
}
