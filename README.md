# Open MCP Gateway (OMG)

> 高性能 MCP 转 OpenAPI 3.1.0 网关，专为 Open WebUI 生态打造。

基于 **Bun 1.4** 与 **TypeScript** 构建。将任意本地部署的 MCP（Model Context Protocol）服务节点——原生二进制 Stdio、Node/Bun 脚本串流管道或 SSE/HTTP 网络传输——统一聚合为严格对齐 **OpenAPI 3.1.0** 规范的 HTTP RESTful 路由，供 Open WebUI 等外部客户端直接作为 Tool 调用。

*社区项目，与 Open WebUI 团队无官方隶属关系。*

## 特性

- **严格 OpenAPI 3.1.0 契约**：工具入参准确挂载于 `requestBody.content['application/json'].schema`；生成的 `operationId` 与原始工具名完全一致，无 `tool_*_post` 式命名污染
- **全传输类型聚合**：Native Binary Stdio / Script Stdio / SSE / HTTP 统一纳管，协议封装、生命周期自愈与热重载
- **蓝绿会话池**：异步互斥锁（AsyncMutex）保障的服务会话热切换，更新配置不中断在途请求
- **跨平台 XDG 四大规范布局**：配置、数据、状态、缓存彻底分离，源码目录零污染
- **单文件二进制分发**：`bun build --compile` 一键产出原生可执行文件，无运行时依赖
- **反向代理友好**：自动解析 `X-Forwarded-*` 请求头，OpenAPI 文档中的 `servers.url` 始终生成为外部真实访问地址

## 架构

```txt
┌──────────────────────────────┐
│        外部客户端            │
│        Open WebUI            │
└──────────────┬───────────────┘
               │ HTTP / HTTPS
               ▼
┌──────────────────────────────┐
│  反向代理 (Caddy / Nginx)    │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│      Open MCP Gateway        │
│  - OpenAPI 3.1.0 规范生成    │
│  - 蓝绿会话池 / 热重载       │
│  - XDG 路径与环境变量插值    │
└──────┬───────────────┬───────┘
       │ JSON-RPC (stdio)
       ▼
┌──────────────────────────────┐
│      各类 MCP 服务进程       │
│  (codebase-memory 等)        │
└──────────────────────────────┘
```

## 安装

```bash
# 源码运行（需 Bun 1.4+）
bun install
bun run dev

# 或编译为单文件原生可执行文件
bun run build   # 产物: build/mcp-gateway(.exe)
```

## 配置

配置文件位于 `$XDG_CONFIG_HOME/mcp-gateway/config.json5`（JSON5 格式，支持注释与尾随逗号），路径支持环境变量动态插值：`${APP_DATA_DIR}`、`${XDG_DATA_HOME}`、`${HOME}` / `%USERPROFILE%` 等，提升跨机可移植性。

```json5
{
    mcpServers: {
        // 示例 1：本地原生二进制 MCP（Native Binary Stdio）
        codebase_memory: {
            command: "${HOME}/.local/bin/codebase-memory-mcp",
            args: [],
            env: {},
        },

        // 示例 2：通过 npm 包运行的 MCP（Script Stdio）
        // 外部包统一安装于 ${APP_DATA_DIR}，详见下文插件管理
        another_mcp: {
            command: "bun",
            args: ["run", "${APP_DATA_DIR}/node_modules/<pkg>/dist/index.js"],
            env: {},
        },
    },

    host: "127.0.0.1",
    port: 9090,
}
```

### XDG 目录布局

| 规范目录 | 环境变量 | 职能 |
| :--- | :--- | :--- |
| Config | `XDG_CONFIG_HOME` | 静态主配置 `config.json5` |
| Data | `XDG_DATA_HOME` | 外部 MCP 插件仓储（独立 `package.json`） |
| State | `XDG_STATE_HOME` | 动态状态与运行时持久化日志 |
| Cache | `XDG_CACHE_HOME` | 规范文档缓存与瞬态运行时数据 |

## 外部 MCP 插件管理

业务型 MCP 扩展包不安装在本工程源码内，统一在数据层集中管理：

```bash
cd "$XDG_DATA_HOME/mcp-gateway"
bun add <mcp-package-name>    # 安装
bun update <pkg>              # 升级
```

## 对接 Open WebUI

1. 启动网关并在其前置一层反向代理（如 Caddy），网关会自动依据 `X-Forwarded-*` 头生成正确的外部基准地址
2. 在 Open WebUI「管理面板 → 函数 / 工具 / OpenAPI」中注册各 MCP 的 OpenAPI 文档地址：

```txt
http://<gateway-host>:8444/codebase_memory/openapi.json
```

3. 完成。Open WebUI 即可像调用原生 Tool 一样使用你本地全部 MCP 服务。

## 测试与日志

```bash
bun run test          # 或: .\ps1_scripts\test-gateway.ps1
                      # 端到端断言: 健康检查 / 服务握手 / 代理 Origin 对齐

tail -f "$XDG_STATE_HOME/mcp-gateway/logs/gateway.log"   # 日志观测
```

## License

MIT
