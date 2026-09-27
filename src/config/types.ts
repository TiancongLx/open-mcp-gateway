export interface StdioServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    timeout?: number;
    // 连接池挂载开关：缺省（不填字段）为开；false = 该服务不建立会话（/servers 呈现 DISABLED）。
    enabled?: boolean;
    // OWUI 图像兼容整形开关：缺省（不填字段）为开；false = 该服务响应恒为 JSON 信封。
    owuiImageCompat?: boolean;
}

export interface SseServerConfig {
    url: string;
    headers?: Record<string, string>;
    timeout?: number;
    // 同 StdioServerConfig.enabled
    enabled?: boolean;
    // 同 StdioServerConfig.owuiImageCompat
    owuiImageCompat?: boolean;
}

export type McpServerConfig = StdioServerConfig | SseServerConfig;

export interface GatewayConfigFile {
    mcpServers: Record<string, McpServerConfig>;
    port?: number;
    host?: string;
}

export function isStdioConfig(config: McpServerConfig): config is StdioServerConfig {
    return 'command' in config && typeof (config as StdioServerConfig).command === 'string';
}

export function isSseConfig(config: McpServerConfig): config is SseServerConfig {
    return 'url' in config && typeof (config as SseServerConfig).url === 'string';
}

// 服务挂载开关判别：显式 enabled: false 判为禁用；缺省（不填字段）与其余值一律视为启用。
export function isServerEnabled(config: McpServerConfig): boolean {
    return config.enabled !== false;
}
