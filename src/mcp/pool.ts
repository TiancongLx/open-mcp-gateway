import { info, warn } from '@/utils/logger';
import { McpSession } from './session';
import { AsyncMutex } from '@/utils/lock';
import type { McpServerConfig, GatewayConfigFile } from '@/config/types';

export class McpPool {
    private sessions: Map<string, McpSession> = new Map();
    private mutex = new AsyncMutex();

    public async initialize(config: GatewayConfigFile): Promise<void> {
        return this.mutex.runExclusive(async () => {
            const entries = Object.entries(config.mcpServers || {});
            await Promise.allSettled(
                entries.map(([name, srvConfig]) => this.addServer(name, srvConfig))
            );
        });
    }

    public async addServer(name: string, config: McpServerConfig): Promise<void> {
        const oldSession = this.sessions.get(name);
        const nextSession = new McpSession(name, config);

        if (!oldSession) {
            this.sessions.set(name, nextSession);
        }

        try {
            await nextSession.connect();
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
            }
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
                    await this.addServer(name, conf);
                } else if (JSON.stringify(existing.config) !== JSON.stringify(conf)) {
                    info(`热重载：平滑重载已变更的服务 [${name}]`);
                    await this.addServer(name, conf);
                }
            }
        });
    }

    public async shutdown(): Promise<void> {
        return this.mutex.runExclusive(async () => {
            info('正在平稳释放所有活动 MCP 会话...');
            const promises = Array.from(this.sessions.values()).map((s) => s.close());
            await Promise.allSettled(promises);
            this.sessions.clear();
            info('所有活动 MCP 会话已完全释放');
        });
    }
}