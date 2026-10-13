export interface StdioServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    timeout?: number;
    // 工具调用时限（毫秒）：单次 callTool 最长等待时间；缺省 30000 ms。
    callTimeoutMs?: number;
    // 连接池挂载开关：缺省（不填字段）为开；false = 该服务不建立会话（/servers 呈现 DISABLED）。
    enabled?: boolean;
    // OWUI 图像兼容整形开关：缺省（不填字段）为开；false = 该服务响应恒为 JSON 信封。
    owuiImageCompat?: boolean;
}

export interface SseServerConfig {
    url: string;
    headers?: Record<string, string>;
    timeout?: number;
    // 同 StdioServerConfig.callTimeoutMs
    callTimeoutMs?: number;
    // 同 StdioServerConfig.enabled
    enabled?: boolean;
    // 同 StdioServerConfig.owuiImageCompat
    owuiImageCompat?: boolean;
}

export interface StreamableHttpServerConfig {
    // 传输判别字段：显式 'streamable-http' 选用 Streamable HTTP 客户端传输（区别于旧式 HTTP+SSE）
    transport: 'streamable-http';
    url: string;
    headers?: Record<string, string>;
    timeout?: number;
    // 同 StdioServerConfig.callTimeoutMs
    callTimeoutMs?: number;
    // 同 StdioServerConfig.enabled
    enabled?: boolean;
    // 同 StdioServerConfig.owuiImageCompat
    owuiImageCompat?: boolean;
    // 断连自愈监督（远程池）：缺省开；false = 关闭退避重连，保留一次性连接语义
    reconnect?: boolean;
    // 退避参数（毫秒）：缺省 1000 / 60000（翻倍递增，±20% 抖动）
    reconnectMinDelayMs?: number;
    reconnectMaxDelayMs?: number;
}

export type McpServerConfig = StdioServerConfig | SseServerConfig | StreamableHttpServerConfig;

export interface GatewayConfigFile {
    mcpServers: Record<string, McpServerConfig>;
    port?: number;
    host?: string;
}

export function isStdioConfig(config: McpServerConfig): config is StdioServerConfig {
    return 'command' in config && typeof (config as StdioServerConfig).command === 'string';
}

export function isStreamableHttpConfig(config: McpServerConfig): config is StreamableHttpServerConfig {
    return 'transport' in config && (config as StreamableHttpServerConfig).transport === 'streamable-http';
}

export function isSseConfig(config: McpServerConfig): config is SseServerConfig {
    return !isStreamableHttpConfig(config) && 'url' in config && typeof (config as SseServerConfig).url === 'string';
}

// 服务挂载开关判别：显式 enabled: false 判为禁用；缺省（不填字段）与其余值一律视为启用。
export function isServerEnabled(config: McpServerConfig): boolean {
    return config.enabled !== false;
}
