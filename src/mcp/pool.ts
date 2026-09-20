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
            this.sessions.set(name, nextSession);
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
