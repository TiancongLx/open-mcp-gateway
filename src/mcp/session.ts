import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { info, error, warn, debug } from '@/utils/logger';
import {
    isStdioConfig,
    isSseConfig,
    isStreamableHttpConfig,
    type McpServerConfig,
    type StreamableHttpServerConfig,
} from '@/config/types';
import { resolve, normalize } from 'node:path';

export type SessionState = 'UNINITIALIZED' | 'CONNECTING' | 'READY' | 'FAILED' | 'DISCONNECTING' | 'TERMINATED';

function normalizeExecutable(cmd: string): string {
    let executable = cmd.trim();
    if (process.platform === 'win32') {
        executable = normalize(executable);
        if (executable.toLowerCase() === 'bun' || executable.toLowerCase() === 'bun.exe') {
            executable = process.execPath;
        }
    }
    return executable;
}

export class McpSession {
    public state: SessionState = 'UNINITIALIZED';
    public lastError: string | null = null;
    public tools: Map<string, Tool> = new Map();
    private client: Client | null = null;
    private transport: Transport | null = null;
    // 远程池断连自愈（S1 批次）：退避重连监督（仅 Streamable HTTP；reconnect:false 关闭）
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectAttempts = 0;
    private closing = false;
    private readonly supervisionAbort = new AbortController();

    constructor(
        public readonly serverName: string,
        public readonly config: McpServerConfig
    ) {}

    // signal：外部中止信号（P1 修复）。停机时可立即终止进行中的握手，
    // 未提供时行为与旧版一致（仅受 timeout 约束）。
    public async connect(signal?: AbortSignal): Promise<void> {
        if (this.closing) {
            throw new Error(`[${this.serverName}] 会话已关闭，拒绝连接`);
        }
        this.state = 'CONNECTING';
        this.lastError = null;
        // 重连复用安全：清退上一轮可能残留的资源（in-flight 重连与关停的竞争由 closing 守卫收敛）
        if (this.client || this.transport) {
            await this.teardownResources();
        }
        debug(`[${this.serverName}] 开始建立通用 MCP 传输连接...`);

        try {
            if (isStdioConfig(this.config)) {
                const command = normalizeExecutable(this.config.command);
                const args = (this.config.args || []).map((arg) => arg.trim());

                const inheritedEnv: Record<string, string> = {};
                for (const [k, v] of Object.entries(process.env)) {
                    if (v !== undefined) {
                        inheritedEnv[k] = v;
                    }
                }

                const env = {
                    ...inheritedEnv,
                    ...(this.config.env || {}),
                };

                this.transport = new StdioClientTransport({
                    command,
                    args,
                    env,
                    cwd: this.config.cwd ? resolve(this.config.cwd) : process.cwd(),
                    stderr: 'pipe',
                });

                const stdioTransport = this.transport as any;
                if (stdioTransport.stderr && typeof stdioTransport.stderr.on === 'function') {
                    stdioTransport.stderr.on('data', (chunk: Buffer) => {
                        const msg = chunk.toString().trim();
                        debug(`[${this.serverName}:stderr] ${msg}`);
                        if (this.state !== 'READY') {
                            this.lastError = msg;
                        }
                    });
                }
            } else if (isStreamableHttpConfig(this.config)) {
                // Streamable HTTP 客户端传输（S1 批次）：认证等头部经 requestInit 透传；
                // 全局 fetch（Bun）承接机器级代理变量（HTTP(S)_PROXY，Xray 自动分流）。
                this.transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
                    requestInit: this.config.headers ? { headers: this.config.headers } : undefined,
                });
            } else if (isSseConfig(this.config)) {
                const sseConf = this.config;
                this.transport = new SSEClientTransport(
                    new URL(sseConf.url),
                    sseConf.headers ? { eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: sseConf.headers }) } } : undefined
                );
            } else {
                throw new Error(`未定义的传输协议配置: ${JSON.stringify(this.config)}`);
            }

            this.client = new Client(
                { name: `open-mcp-gateway-${this.serverName}`, version: '1.0.0' },
                { capabilities: {} }
            );

            const timeoutMs = this.config.timeout || 50000;
            let timeoutId: ReturnType<typeof setTimeout> | null = null;

            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`MCP 节点握手超时 (${timeoutMs}ms)`));
                }, timeoutMs);
            });

            // P1 修复：外部中止 promise。signal 已中止则立即拒绝，否则 abort 事件触发时拒绝。
            // Promise.race 输方仍会悬挂，赢家抛出后必须在 finally 移除监听，避免 promise 泄漏。
            // TS 控制流不追踪 Promise executor 回调内的赋值（变量会被收窄为 null → 对其可选调用得到 never）。
            // 故监听接线提到顶层作用域，用 Promise.withResolvers（ES2024）显式取 reject。
            let abortCleanup: (() => void) | null = null;
            let abortPromise: Promise<never> | null = null;
            if (signal) {
                const { promise, reject } = Promise.withResolvers<never>();
                const onAbort = () => reject(new Error('连接握手已被中止 (aborted)'));
                signal.addEventListener('abort', onAbort, { once: true });
                abortCleanup = () => signal.removeEventListener('abort', onAbort);
                if (signal.aborted) {
                    onAbort();
                }
                abortPromise = promise;
            }

            const connectPromise = (async () => {
                await this.client!.connect(this.transport!);
                await this.refreshTools();
            })();

            connectPromise.catch((innerErr) => {
                debug(`[${this.serverName}] 异步握手终止通知: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`);
            });

            const racers: Promise<void>[] = [connectPromise, timeoutPromise];
            if (abortPromise) {
                racers.push(abortPromise);
            }

            try {
                await Promise.race(racers);
            } finally {
                if (timeoutId) clearTimeout(timeoutId);
                abortCleanup?.();
            }

            if (this.closing) {
                throw new Error(`[${this.serverName}] 连接期间会话被关闭`);
            }
            this.state = 'READY';
            this.lastError = null;
            this.reconnectAttempts = 0;
            info(`[${this.serverName}] 节点就绪，成功注册 ${this.tools.size} 个工具: [${Array.from(this.tools.keys()).join(', ')}]`);
            this.attachSupervision();
        } catch (err) {
            const errorMsg = err instanceof Error ? (err.stack || err.message) : String(err);
            this.lastError = errorMsg;
            this.state = 'FAILED';
            error(`[${this.serverName}] 节点拉起失败: ${errorMsg}`);
            await this.teardownResources();
            this.tools.clear();
            this.state = 'FAILED';
            throw err;
        }
    }

    public async refreshTools(): Promise<void> {
        if (!this.client) return;
        const res = await this.client.listTools();
        this.tools.clear();
        for (const tool of res.tools) {
            this.tools.set(tool.name, tool);
        }
    }

    public async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
        if (this.state !== 'READY' || !this.client) {
            throw new Error(`MCP 服务 [${this.serverName}] 未就绪 (状态: ${this.state})`);
        }
        if (!this.tools.has(name)) {
            throw new Error(`服务 [${this.serverName}] 不包含工具 [${name}]`);
        }

        const timeoutMs = this.config.callTimeoutMs ?? 30000;
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);

        try {
            const result = await this.client.callTool(
                {
                    name,
                    arguments: args,
                },
                undefined, // resultSchema
                { signal: controller.signal }
            );
            return result;
        } catch (err) {
            // 远程自愈（S1）：非超时异常视为疑似传输故障，触发监督重连（READY 期一次事件即入监督）
            if (!timedOut) {
                this.noteTransportFailure(err);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    public async close(): Promise<void> {
        this.closing = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (!this.supervisionAbort.signal.aborted) {
            this.supervisionAbort.abort();
        }

        const previousState = this.state;
        this.state = 'DISCONNECTING';

        await this.teardownResources();

        this.tools.clear();
        this.state = (previousState === 'FAILED') ? 'FAILED' : 'TERMINATED';
        debug(`[${this.serverName}] 资源已安全释放`);
    }

    // ---- 远程断连自愈（S1 批次）：退避重连监督 ----

    // 池侧探针：本会话是否具备自愈能力（Streamable HTTP 且未显式关闭 reconnect）
    public get canSelfHeal(): boolean {
        return this.supervisionEnabled;
    }

    private get supervisionEnabled(): boolean {
        return isStreamableHttpConfig(this.config) && this.config.reconnect !== false;
    }

    // 初始连接失败后的监督入口（由池保留本会话时调用）：直接进入退避重连
    public beginSupervision(): void {
        if (this.closing || !this.supervisionEnabled) return;
        this.scheduleReconnect();
    }

    private attachSupervision(): void {
        if (!this.supervisionEnabled || !this.client) return;
        const client = this.client;
        client.onclose = () => {
            if (this.closing || this.client !== client) return;
            // 仅 READY 期的关闭视为意外断连；重连流程内部的关闭由状态守卫忽略
            if (this.state !== 'READY') return;
            warn(`[${this.serverName}] 远程连接已关闭，进入退避重连监督`);
            this.state = 'FAILED';
            this.lastError = '远程连接已关闭（等待自动重连）';
            this.scheduleReconnect();
        };
        client.onerror = (err) => {
            debug(`[${this.serverName}] 远程传输告警: ${err instanceof Error ? err.message : String(err)}`);
        };
    }

    private scheduleReconnect(): void {
        if (this.closing || !this.supervisionEnabled || this.reconnectTimer) return;
        const cfg = this.config as StreamableHttpServerConfig;
        const minDelay = cfg.reconnectMinDelayMs ?? 1000;
        const maxDelay = cfg.reconnectMaxDelayMs ?? 60000;
        const base = Math.min(minDelay * 2 ** this.reconnectAttempts, maxDelay);
        const delay = Math.round(base * (0.8 + Math.random() * 0.4));
        this.reconnectAttempts += 1;
        warn(`[${this.serverName}] ${delay}ms 后执行第 ${this.reconnectAttempts} 次重连尝试`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.attemptReconnect();
        }, delay);
    }

    private async attemptReconnect(): Promise<void> {
        if (this.closing) return;
        this.state = 'CONNECTING';
        try {
            await this.connect(this.supervisionAbort.signal);
            info(`[${this.serverName}] 重连成功，已重新注册 ${this.tools.size} 个工具`);
        } catch (err) {
            warn(`[${this.serverName}] 重连失败: ${err instanceof Error ? err.message : String(err)}`);
            this.state = 'FAILED';
            this.scheduleReconnect();
        }
    }

    private noteTransportFailure(err: unknown): void {
        if (this.closing || !this.supervisionEnabled || this.state !== 'READY') return;
        const msg = err instanceof Error ? err.message : String(err);
        warn(`[${this.serverName}] 工具调用失败疑似连接异常，触发重连监督: ${msg}`);
        this.state = 'FAILED';
        this.lastError = msg;
        this.scheduleReconnect();
    }

    private async teardownResources(): Promise<void> {
        const stdioTransport = this.transport as any;
        const childProc = stdioTransport?._process || stdioTransport?.process;
        const stdioPid = childProc?.pid;

        try {
            if (this.client) {
                await this.client.close();
            }
        } catch (err) {
            warn(`[${this.serverName}] 释放 Client 产生告警: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            if (process.platform === 'win32' && stdioPid) {
                try {
                    Bun.spawnSync(['taskkill', '/F', '/T', '/PID', String(stdioPid)]);
                } catch {}
            }
            this.client = null;
            this.transport = null;
        }
    }
}
