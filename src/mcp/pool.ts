import { info, warn } from '@/utils/logger';
import { McpSession } from './session';
import { AsyncMutex } from '@/utils/lock';
import type { McpServerConfig, GatewayConfigFile } from '@/config/types';

export class McpPool {
    private sessions: Map<string, McpSession> = new Map();
    private mutex = new AsyncMutex();
    // P1 修复：连接握手的统一中止源；停机时 abort 全部进行中的 connect
    private abortController = new AbortController();
    // 进行中的连接任务集合，shutdown() 在拿锁前等待其落定
    private inFlight = new Set<Promise<void>>();

    public async initialize(config: GatewayConfigFile): Promise<void> {
        return this.mutex.runExclusive(async () => {
            const entries = Object.entries(config.mcpServers || {});
            await Promise.allSettled(
                entries.map(([name, srvConfig]) => this.addServer(name, srvConfig))
            );
        });
    }

    public async addServer(name: string, config: McpServerConfig, signal?: AbortSignal): Promise<void> {
        const oldSession = this.sessions.get(name);
        const nextSession = new McpSession(name, config);

        if (!oldSession) {
            this.sessions.set(name, nextSession);
        }

        // P2-stale 修复：连接任务登记进 inFlight，供 shutdown() 在拿锁前等待
        const attempt = (async () => {
            try {
                await nextSession.connect(signal ?? this.abortController.signal);
                this.sessions.set(name, nextSession);
                if (oldSession && oldSession !== nextSession) {
                    await oldSession.close();
                }
            } catch (err) {
                warn(`[${name}] 会话连接未能建立: ${err instanceof Error ? err.message : String(err)}`);
                await nextSession.close();
                // P0-2 修复：连接失败时绝不覆盖既有会话。旧行为用 FAILED 的 nextSession
                // 顶替 map 中的 oldSession → ① 健康 READY 会话被踢下线（可用性回退）；
                // ② 旧 stdio 子进程失去唯一引用成为孤儿进程，反复改坏配置即累积泄漏。
                // 仅在首次注册时登记 FAILED 态，供 /servers 与后续热重载观测。
                if (!oldSession) {
                    this.sessions.set(name, nextSession);
                } else if (oldSession.state !== 'READY') {
                    // P2-stale 修复（审查 finding 2）：保留的是不可用会话时，
                    // 刷新其 lastError 为本次最新失败原因，避免 /servers 长期
                    // 陈述上一次（乃至首次注册）的错误。
                    oldSession.lastError = err instanceof Error ? (err.stack || err.message) : String(err);
                }
            }
        })();
        this.inFlight.add(attempt);
        try {
            await attempt;
        } finally {
            this.inFlight.delete(attempt);
        }
    }

    public async removeServer(name: string): Promise<void> {
        const session = this.sessions.get(name);
        if (!session) return;
        await session.close();
        this.sessions.delete(name);
        info(`[${name}] 服务已被安全下线`);
    }

    public getSession(name: string): McpSession | undefined {
        return this.sessions.get(name);
    }

    public getAllSessions(): Map<string, McpSession> {
        return this.sessions;
    }

    public async reconcile(newConfig: GatewayConfigFile): Promise<void> {
        return this.mutex.runExclusive(async () => {
            const newServers = newConfig.mcpServers || {};
            const currentNames = new Set(this.sessions.keys());
            const incomingNames = new Set(Object.keys(newServers));

            for (const name of currentNames) {
                if (!incomingNames.has(name)) {
                    info(`热重载：下线服务 [${name}]`);
                    await this.removeServer(name);
                }
            }

            for (const [name, conf] of Object.entries(newServers)) {
                const existing = this.sessions.get(name);
                if (!existing || existing.state !== 'READY') {
                    info(`热重载：挂载服务 [${name}]`);
                    await this.addServer(name, conf, this.abortController.signal);
                } else if (JSON.stringify(existing.config) !== JSON.stringify(conf)) {
                    info(`热重载：平滑重载已变更的服务 [${name}]`);
                    await this.addServer(name, conf, this.abortController.signal);
                }
            }
        });
    }

    // P1 修复：shutdown 不再持锁等待。旧实现 runExclusive 排队在 initialize /
    // reconcile 之后，50s 长握手期间 5s 停机看门狗必然先触发 process.exit(1)。
    // 新顺序：① abort 中止全部进行中的 connect；② 等待连接任务落定；
    // ③ 此后锁必然空闲，再串行释放会话。
    public async shutdown(): Promise<void> {
        info('正在中止进行中的连接握手...');
        this.abortController.abort();

        if (this.inFlight.size > 0) {
            await Promise.allSettled(Array.from(this.inFlight));
        }

        return this.mutex.runExclusive(async () => {
            info('正在平稳释放所有活动 MCP 会话...');
            const promises = Array.from(this.sessions.values()).map((s) => s.close());
            await Promise.allSettled(promises);
            this.sessions.clear();
            info('所有活动 MCP 会话已完全释放');
        });
    }

    // 供测试/健康检查观测握手压力（不可重入契约的守门依据，见 utils/lock.ts 头注）
    public get hasInFlightConnections(): boolean {
        return this.inFlight.size > 0;
    }
}
