export interface StdioServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    timeout?: number;
}

export interface SseServerConfig {
    url: string;
    headers?: Record<string, string>;
    timeout?: number;
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
