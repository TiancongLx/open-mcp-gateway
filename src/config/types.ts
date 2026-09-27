export interface StdioServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    timeout?: number;
    // OWUI 图像兼容整形开关：缺省（不填字段）为开；false = 该服务响应恒为 JSON 信封。
    owuiImageCompat?: boolean;
}

export interface SseServerConfig {
    url: string;
    headers?: Record<string, string>;
    timeout?: number;
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
