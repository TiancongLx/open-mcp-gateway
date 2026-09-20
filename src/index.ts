import { resolveXdg } from '@/config/xdg';
import { ConfigManager } from '@/config/loader';
import { McpPool } from '@/mcp/pool';
import { GatewayServer } from '@/server/gateway';
import { info, error, warn, initFileLogging } from '@/utils/logger';

async function main() {
    // 1. 初始化标准 XDG 物理环境并接入日志持久化
    const xdg = resolveXdg();
    initFileLogging(xdg.logFilePath);

    info(`「mcp-gateway」启动中 (Bun ${Bun.version})...`);
    info(`[XDG Config] 配置文件路径: ${xdg.activeConfigFile}`);
    info(`[XDG State]  运行时日志文件: ${xdg.logFilePath}`);
    info(`[XDG Data]   共享数据存储区: ${xdg.dataHome}`);
    info(`[XDG Cache]  高速缓存存储区: ${xdg.cacheHome}`);

    // 2. 加载核心配置
    const configManager = new ConfigManager(xdg.activeConfigFile, xdg);
    const initialConfig = await configManager.load();

    // 3. 构建连接池与网关
    const pool = new McpPool();

    const port = Number(process.env.PORT) || initialConfig.port || 9090;
    const host = process.env.HOST || initialConfig.host || '127.0.0.1';

    const gateway = new GatewayServer(pool, { port, host });
    gateway.start();

    // 4. 注册文件监控与热重载
    configManager.watch(async (newConfig) => {
        await pool.reconcile(newConfig);
    });

    // 5. 初始化已有 MCP 服务池
    info('正在初始化 MCP 服务连接池...');
    try {
        await pool.initialize(initialConfig);
        gateway.setPoolReady(true);
        info('MCP 服务池初始化完毕，网关全面就绪');
    } catch (err) {
        warn(`MCP 服务池存在未就绪节点: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 6. 优雅停机托管
    let isShuttingDown = false;
    const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        info('收到停机信号，正在平稳释放网络与子进程资源...');
        const watchdog = setTimeout(() => {
            warn('强制退出看门狗触发');
            process.exit(1);
        }, 5000);
        watchdog.unref();

        configManager.stopWatch();
        gateway.stop();
        await pool.shutdown();

        info('mcp-gateway 已安全退出');
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('unhandledRejection', (reason) => {
        warn(`[未捕获 Promise 异常] ${reason instanceof Error ? (reason.stack || reason.message) : String(reason)}`);
    });
}

main().catch((err) => {
    error(`网关遭遇致命错误: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    process.exit(1);
});
