import { watch, type FSWatcher } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { info, warn, error } from '@/utils/logger';
import { interpolateVariables, type XdgEnvironment } from './xdg';
import type { GatewayConfigFile } from './types';

export type ConfigChangeCallback = (newConfig: GatewayConfigFile) => Promise<void> | void;

export class ConfigManager {
    private watcher: FSWatcher | null = null;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private currentConfig: GatewayConfigFile = { mcpServers: {} };
    private readonly absConfigPath: string;

    constructor(
        configPath: string,
        private readonly xdg: XdgEnvironment
    ) {
        this.absConfigPath = resolve(configPath);
    }

    public async load(): Promise<GatewayConfigFile> {
        const configFile = Bun.file(this.absConfigPath);
        if (!(await configFile.exists())) {
            warn(`配置文件未就绪: ${this.absConfigPath}，网关以空状态初始化`);
            this.currentConfig = { mcpServers: {} };
            return this.currentConfig;
        }

        let retries = 3;
        while (retries > 0) {
            try {
                const text = await configFile.text();
                if (!text.trim()) throw new Error('配置文本为空');

                const parsed = Bun.JSON5.parse(text) as GatewayConfigFile;
                if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
                    parsed.mcpServers = {};
                }

                // 对每一个节点参数执行 XDG 变量解构
                for (const [srvName, srvConf] of Object.entries(parsed.mcpServers)) {
                    if ('command' in srvConf && typeof srvConf.command === 'string') {
                        srvConf.command = interpolateVariables(srvConf.command, this.xdg);
                        if (Array.isArray(srvConf.args)) {
                            srvConf.args = srvConf.args.map((a) => interpolateVariables(a, this.xdg));
                        }
                        if (srvConf.cwd) {
                            srvConf.cwd = interpolateVariables(srvConf.cwd, this.xdg);
                        }
                    } else if ('url' in srvConf && typeof srvConf.url === 'string') {
                        srvConf.url = interpolateVariables(srvConf.url, this.xdg);
                    }
                }

                this.currentConfig = parsed;
                info(`已成功加载配置: ${this.absConfigPath} (生效服务: ${Object.keys(parsed.mcpServers).join(', ') || '无'})`);
                return this.currentConfig;
            } catch (err) {
                retries--;
                if (retries === 0) {
                    error(`解析配置文件异常: ${err instanceof Error ? err.message : String(err)}`);
                    return this.currentConfig;
                }
                await Bun.sleep(80);
            }
        }

        return this.currentConfig;
    }

    public watch(onChange: ConfigChangeCallback): void {
        const watchDir = dirname(this.absConfigPath);
        const targetFilename = basename(this.absConfigPath);

        try {
            this.watcher = watch(watchDir, (eventType, triggeredFilename) => {
                if (!triggeredFilename) return;
                if (basename(triggeredFilename) === targetFilename) {
                    if (this.debounceTimer) clearTimeout(this.debounceTimer);
                    this.debounceTimer = setTimeout(async () => {
                        info(`检测到配置文件变动，执行热重载调度...`);
                        const reloaded = await this.load();
                        try {
                            await onChange(reloaded);
                        } catch (err) {
                            error(`热重载回调执行异常: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    }, 300);
                }
            });
        } catch (err) {
            warn(`注册配置文件监视器失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    public stopWatch(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }

    public getConfig(): GatewayConfigFile {
        return this.currentConfig;
    }
}
