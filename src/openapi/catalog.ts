// 统一工具目录（catalog face，决策 24）：跨池检索（search_tools）与调度（call_tool）。
// 挂载于保留命名空间 /omg；旧三池路径行为零变更。
//
// 设计不变式（源自 CHTR-0001 故障因果）：
//   ① 模型可调用的名字恒为已声明工具（严格函数栈安全）；
//   ② 大 schema 以「工具结果」按需返回（提示词缓存前缀不被改写）；
//   ③ provider tools 数组随池状态稳定。
//
// 检索语义：精确工具名直返命中；否则按加权重叠排名（name×3 / 服务名×2 / 参数名×2 /
// description×1；camelCase 拆分 + CJK 二元组）；count 缺省 5、上限 20
// （对齐 OWUI Tool Search 参数语义）。search_tools 描述内嵌「服务: 工具名」
// 清单（manifest）与内容指纹（catalog fingerprint）——清单字面不变则规格
// 字节恒稳（跨请求前缀缓存前提，设计不变式 ③）；内容变化则指纹变化；
// 搜索与调用实时。
import { createHash } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpPool } from '@/mcp/pool';
import type { McpSession } from '@/mcp/session';
import type { OpenApiSpec31 } from '@/openapi/generator';

export const CATALOG_NAMESPACE = 'omg';
export const SEARCH_TOOL_NAME = 'search_tools';
export const CALL_TOOL_NAME = 'call_tool';
export const DEFAULT_SEARCH_COUNT = 5;
export const MAX_SEARCH_COUNT = 20;
export const MANIFEST_BUDGET_CHARS = 1700; // 五池 76 工具全名清单约 1.5k 字符；超预算逐级截断并标记

export interface CatalogToolEntry {
    server: string;
    name: string;
    description: string;
    inputSchema: unknown;
}

export interface CatalogSearchHit {
    server: string;
    name: string;
    description: string;
    input_schema: unknown;
}

export interface PoolCatalogView {
    ready: Array<{ server: string; tools: CatalogToolEntry[]; instructions?: string | null }>;
    unavailable: string[];
}

// ---- 分词：camelCase 拆分 + CJK 二元组（与 OWUI Tool Search 语义对齐）----

const WORD_RE = /[\p{L}\p{N}\p{M}]+/gu;
const CAMEL_SPLIT_RE = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;
const CJK_GROUP_RE = /([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+)/;
const CJK_RUN_RE = /^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+$/;

export function tokenize(text: string | null | undefined): string[] {
    const tokens: string[] = [];
    for (const word of (text ?? '').normalize('NFKC').match(WORD_RE) ?? []) {
        for (const part of word.split(CAMEL_SPLIT_RE)) {
            for (const chunk of part.toLowerCase().split(CJK_GROUP_RE)) {
                if (!chunk) continue;
                if (CJK_RUN_RE.test(chunk)) {
                    if (chunk.length === 1) {
                        tokens.push(chunk);
                    } else {
                        for (let i = 0; i < chunk.length - 1; i++) {
                            tokens.push(chunk.slice(i, i + 2));
                        }
                    }
                } else {
                    tokens.push(chunk);
                }
            }
        }
    }
    return tokens;
}

function propertyKeys(inputSchema: unknown): string[] {
    if (!inputSchema || typeof inputSchema !== 'object') return [];
    const properties = (inputSchema as { properties?: unknown }).properties;
    if (!properties || typeof properties !== 'object') return [];
    return Object.keys(properties as Record<string, unknown>);
}

function scoreEntry(entry: CatalogToolEntry, queryTokens: string[]): number {
    const nameTokens = new Set(tokenize(entry.name));
    const serverTokens = new Set(tokenize(entry.server));
    const paramTokens = new Set(tokenize(propertyKeys(entry.inputSchema).join(' ')));
    const descriptionTokens = new Set(tokenize(entry.description));
    let score = 0;
    for (const token of queryTokens) {
        if (nameTokens.has(token)) score += 3;
        if (serverTokens.has(token)) score += 2; // 服务名：低权重信号（服务名查询直指该服务工具）
        if (paramTokens.has(token)) score += 2;
        if (descriptionTokens.has(token)) score += 1;
    }
    return score;
}

function toHit(entry: CatalogToolEntry): CatalogSearchHit {
    return {
        server: entry.server,
        name: entry.name,
        description: entry.description,
        input_schema: entry.inputSchema,
    };
}

export function clampCount(count: number | undefined): number {
    if (count === undefined || !Number.isFinite(count)) {
        return DEFAULT_SEARCH_COUNT;
    }
    return Math.max(1, Math.min(Math.floor(count), MAX_SEARCH_COUNT));
}

export function searchCatalog(
    entries: CatalogToolEntry[],
    query: string,
    count?: number,
    serverFilter?: string
): CatalogSearchHit[] {
    const scope = serverFilter ? entries.filter((entry) => entry.server === serverFilter) : entries;
    const q = (query ?? '').trim();
    if (!q) return [];

    // 精确工具名直返；跨池重名时全量返回，供调用侧以 server 消歧
    const exact = scope.filter((entry) => entry.name === q);
    if (exact.length > 0) {
        return exact.sort((a, b) => a.server.localeCompare(b.server)).map(toHit);
    }

    const queryTokens = Array.from(new Set(tokenize(q)));
    if (queryTokens.length === 0) return [];

    const scored = scope
        .map((entry) => ({ entry, score: scoreEntry(entry, queryTokens) }))
        .filter((candidate) => candidate.score > 0)
        .sort(
            (a, b) =>
                b.score - a.score ||
                a.entry.name.localeCompare(b.entry.name) ||
                a.entry.server.localeCompare(b.entry.server)
        );

    return scored.slice(0, clampCount(count)).map((candidate) => toHit(candidate.entry));
}

// 服务枚举（人机工程迭代 2026-10-13）：返回指定服务全部工具，按名排序；
// count 缺省 = 全量，显式时截断；安全上限防意外拉爆。
export const ENUMERATE_SAFETY_MAX = 100;

export function enumerateCatalog(entries: CatalogToolEntry[], server: string, count?: number): CatalogSearchHit[] {
    const tools = entries
        .filter((entry) => entry.server === server)
        .sort((a, b) => a.name.localeCompare(b.name));
    const limit =
        count === undefined || !Number.isFinite(count)
            ? ENUMERATE_SAFETY_MAX
            : Math.max(1, Math.min(Math.floor(count), ENUMERATE_SAFETY_MAX));
    return tools.slice(0, limit).map(toHit);
}

// ---- 池视图与清单（manifest）----

export function collectPoolView(pool: McpPool): PoolCatalogView {
    const ready: PoolCatalogView['ready'] = [];
    const unavailable: string[] = [];

    const sessions = Array.from(pool.getAllSessions().entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [server, session] of sessions) {
        if (session.state === 'READY') {
            const tools = Array.from(session.tools.values())
                .map((tool: Tool) => ({
                    server,
                    name: tool.name,
                    description: tool.description ?? '',
                    inputSchema: tool.inputSchema,
                }))
                .sort((a, b) => a.name.localeCompare(b.name));
            ready.push({ server, tools, instructions: session.instructions ?? null });
        } else {
            unavailable.push(server);
        }
    }

    // enabled=false 服务不建会话：从禁用登记簿补充
    for (const server of pool.getDisabledServers().keys()) {
        if (!unavailable.includes(server)) {
            unavailable.push(server);
        }
    }
    unavailable.sort();

    return { ready, unavailable };
}

export function buildManifestText(view: PoolCatalogView, budget = MANIFEST_BUDGET_CHARS): { text: string; truncated: boolean } {
    let text = '';
    let truncated = false;

    for (const { server, tools } of view.ready) {
        if (tools.length === 0) continue;

        const names = tools.map((tool) => tool.name);
        const fullLine = `- ${server}: ${names.join(', ')}`;
        if (text.length + (text ? 1 : 0) + fullLine.length <= budget) {
            text += (text ? '\n' : '') + fullLine;
            continue;
        }

        // 预算内截到最后一个完整工具名，以 … 收尾后停止
        let partial = `- ${server}:`;
        for (const name of names) {
            const candidate = `${partial} ${name},`;
            if (text.length + (text ? 1 : 0) + candidate.length > budget) break;
            partial = candidate;
        }
        if (partial !== `- ${server}:`) {
            text += (text ? '\n' : '') + partial.replace(/,$/, '') + ' …';
        }
        truncated = true;
        break;
    }

    return { text, truncated };
}

// ---- 调用目标解析（READY 门控 / 歧义列表 / 未知候选提示）----

export type CatalogCallResolution =
    | { kind: 'ok'; server: string; session: McpSession }
    | { kind: 'reject'; status: number; body: Record<string, unknown>; retryAfter?: string };

function notReadyReject(server: string, session: McpSession): CatalogCallResolution {
    return {
        kind: 'reject',
        status: 503,
        body: {
            error: `Server [${server}] not ready`,
            state: session.state,
            lastError: session.lastError,
        },
        retryAfter: session.state === 'CONNECTING' ? '2' : undefined,
    };
}

function suggestNames(pool: McpPool, tool: string): Array<{ server: string; name: string }> {
    const entries = collectPoolView(pool).ready.flatMap((server) => server.tools);
    return searchCatalog(entries, tool, 5).map((hit) => ({ server: hit.server, name: hit.name }));
}

export function resolveCallTarget(pool: McpPool, tool: string, server?: string): CatalogCallResolution {
    if (server) {
        const session = pool.getSession(server);
        if (!session) {
            if (pool.getDisabledServers().has(server)) {
                return { kind: 'reject', status: 503, body: { error: `Server [${server}] disabled`, state: 'DISABLED' } };
            }
            return { kind: 'reject', status: 404, body: { error: `Server [${server}] not found` } };
        }
        if (session.state !== 'READY') {
            return notReadyReject(server, session);
        }
        if (!session.tools.has(tool)) {
            return {
                kind: 'reject',
                status: 400,
                body: { error: `Tool [${tool}] not found on server [${server}]`, suggestions: suggestNames(pool, tool) },
            };
        }
        return { kind: 'ok', server, session };
    }

    // 未指定 server：按名跨池解析
    const matches: Array<{ server: string; session: McpSession }> = [];
    for (const [name, session] of pool.getAllSessions()) {
        if (session.tools.has(tool)) {
            matches.push({ server: name, session });
        }
    }
    matches.sort((a, b) => a.server.localeCompare(b.server));

    if (matches.length === 0) {
        return { kind: 'reject', status: 400, body: { error: `Tool [${tool}] not found`, suggestions: suggestNames(pool, tool) } };
    }
    if (matches.length > 1) {
        return {
            kind: 'reject',
            status: 400,
            body: {
                error: `Tool [${tool}] is ambiguous across servers`,
                candidates: matches.map((match) => ({ server: match.server, tool })),
            },
        };
    }

    const target = matches[0];
    if (target.session.state !== 'READY') {
        return notReadyReject(target.server, target.session);
    }
    return { kind: 'ok', server: target.server, session: target.session };
}

// ---- 统一 compact 规格（/omg）----

const SEARCH_DESCRIPTION =
    'Search the MCP tool catalog and return full tool definitions. ' +
    'Pass an exact tool name to get that tool directly, or a short keyword query for ranked matches. ' +
    'Pass server (or use the exact server name as the query) to enumerate every tool of that server. ' +
    'Use it before calling a tool when you need its input_schema. ' +
    'Then execute with call_tool, passing the tool name and arguments.';

const CALL_DESCRIPTION =
    'Execute a tool from the MCP catalog by name. ' +
    'Pass arguments as a JSON object matching the tool input_schema (fetch it with search_tools first). ' +
    'When several servers expose the same tool name, pass server to disambiguate. ' +
    'If the call fails, the error result includes the tool input_schema so you can fix the arguments without searching again. ' +
    'Image results follow the same three-state content negotiation as per-server routes.';

const EXECUTION_RESPONSE_DESCRIPTION =
    'Tool execution result, content-negotiated: default (*/*) returns a bare data: URI string for ' +
    'single-image results (text/plain); Accept: image/* returns raw image bytes; Accept: application/json ' +
    'returns the JSON CallToolResult envelope; per-server owuiImageCompat=false pins the envelope.';

// 清单内容指纹（决策 24（m））：以清单体内容（含截断标记）为输入的短哈希。
// 内容不变 → 指纹与规格字节恒稳（设计不变式 ③，provider 前缀缓存前提）；
// 内容变化 → 指纹变化（承接（j）② 的「漂移可辨识」语义；检索响应 generated_at 不在本面）。
export function manifestFingerprint(manifestBody: string): string {
    return createHash('sha256').update(manifestBody).digest('hex').slice(0, 12);
}

export function buildUnifiedSpec(pool: McpPool, publicOrigin: string): OpenApiSpec31 {
    const view = collectPoolView(pool);
    const manifest = buildManifestText(view);
    const manifestBody = `${manifest.text}${manifest.truncated ? '\n…' : ''}`;
    const manifestBlock = manifest.text
        ? `Currently available tools (catalog fingerprint: ${manifestFingerprint(manifestBody)}):\n${manifestBody}`
        : 'No tools are currently ready.';

    return {
        openapi: '3.1.0',
        info: {
            title: `MCP Gateway - ${CATALOG_NAMESPACE} (unified catalog)`,
            version: '1.0.0',
            description:
                'Unified MCP tool catalog over all ready servers: search_tools returns full definitions on demand; ' +
                'call_tool executes a tool by name. Per-server routes remain available for direct access.',
        },
        servers: [
            {
                url: `${publicOrigin}/${CATALOG_NAMESPACE}`,
                description: 'Unified catalog endpoint cluster',
            },
        ],
        paths: {
            '/tools/search': {
                post: {
                    operationId: SEARCH_TOOL_NAME,
                    summary: SEARCH_TOOL_NAME,
                    description: `${SEARCH_DESCRIPTION}\n\n${manifestBlock}`,
                    requestBody: {
                        required: true,
                        description: 'Search query and optional result count',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        query: {
                                            type: 'string',
                                            description: 'Exact tool name, keywords, or an exact server name (enumerates that server). Optional when server is given.',
                                        },
                                        count: {
                                            type: 'integer',
                                            description: 'Max results (ranked search default 5, up to 20; server enumeration returns all unless set).',
                                        },
                                        server: {
                                            type: 'string',
                                            description: 'Scope the search to one server; omit query to enumerate every tool of it.',
                                        },
                                    },
                                    required: [],
                                },
                            },
                        },
                    },
                    responses: {
                        '200': {
                            description:
                                'Matched or enumerated tools with full definitions: ' +
                                '{count, tools:[{server,name,description,input_schema}], unavailable_servers:[...], generated_at}; ' +
                                'count is the number of returned tools; zero matches include a hint.',
                        },
                        '400': {
                            description: "Invalid JSON payload, or missing both 'query' and 'server'",
                        },
                        '500': {
                            description: 'Internal exception',
                        },
                    },
                },
            },
            '/tools/call': {
                post: {
                    operationId: CALL_TOOL_NAME,
                    summary: CALL_TOOL_NAME,
                    description: CALL_DESCRIPTION,
                    requestBody: {
                        required: true,
                        description: 'Target tool and arguments',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        tool: {
                                            type: 'string',
                                            description: 'Tool name as returned by search_tools.',
                                        },
                                        server: {
                                            type: 'string',
                                            description: 'Optional server name to disambiguate same-named tools.',
                                        },
                                        arguments: {
                                            type: 'object',
                                            description: 'Tool arguments matching the tool input_schema.',
                                        },
                                    },
                                    required: ['tool'],
                                },
                            },
                        },
                    },
                    responses: {
                        '200': {
                            description: EXECUTION_RESPONSE_DESCRIPTION,
                        },
                        '400': {
                            description: 'Unknown or ambiguous tool / invalid payload',
                        },
                        '404': {
                            description: 'Unknown server',
                        },
                        '503': {
                            description: 'Server not ready or disabled',
                        },
                        '500': {
                            description: 'Internal tool execution exception',
                        },
                    },
                },
            },
        },
    };
}
