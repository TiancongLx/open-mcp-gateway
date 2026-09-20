# MCP Gateway (Model Context Protocol 网关)

基于 **Bun 1.4.2** 与 **TypeScript 7** 构建的高性能、高可用 Model Context Protocol 网关服务。

网关核心职责：负责统一聚合下游通过原生二进制（Native Binary Stdio）、Node/Bun 串流管道（Script Stdio）或网络协议（SSE / HTTP）启动的各类 MCP 服务节点，完成协议封装、生命周期自愈与热重载，并对外提供严格对齐 **OpenAPI 3.1.0** 标准规范的 HTTP RESTful 路由中枢，供外部客户端（如 Open WebUI）通过 Caddy 反向代理安全调用。

---

## 一、 系统架构拓扑

```txt
┌────────────────────────────────────────────────────────┐
│                      外部客户端                        │
│                     Open WebUI                         │
└──────────────────────────┬─────────────────────────────┘
                           │ HTTP / HTTPS (REST API)
                           ▼
┌────────────────────────────────────────────────────────┐
│                    反向代理网关                        │
│                   Caddy (:8444)                        │
└──────────────────────────┬─────────────────────────────┘
                           │ HTTP 反向代理转发 (:8444 -> :9090)
                           ▼
┌────────────────────────────────────────────────────────┐
│               核心路由与协议转换网关                   │
│                mcp-gateway (:9090)                     │
│  - OpenAPI 3.1.0 规范生成                              │
│  - 异步互斥锁 (AsyncMutex) 保障的蓝绿会话池             │
│  - 跨平台 XDG 四大规范路径与环境变量插值引擎           │
└──────────────┬──────────────────────────┬──────────────┘
               │                          │
   JSON-RPC (Native Stdio)    JSON-RPC (Bun Stdio 串流管道)
               │                          │
               ▼                          ▼
┌─────────────────────────────┐ ┌─────────────────────────────────────────┐
│        底层原生进程         │ │               串流子进程                │
│       codebase_memory       │ │          Next AI Draw.io Server         │
│ (C:/Users/root/.local/bin)  │ │ (C:/Users/root/.local/share/mcp-gateway)│
└─────────────────────────────┘ └─────────────────────────────────────────┘
```

---

## 二、 严格遵循 XDG 四大规范的物理布局

为了消除项目源码目录与运行时数据、配置的混杂，本项目严格按照操作系统环境变量（`XDG_*`）分离运行资产：

| 规范目录 | 环境变量 | 默认物理路径 (Windows) | 职能定义 |
| :--- | :--- | :--- | :--- |
| **Config** | `XDG_CONFIG_HOME` | `C:\Users\root\.config\mcp-gateway\` | 静态主配置文件 `config.json5` |
| **Data** | `XDG_DATA_HOME` | `C:\Users\root\.local\share\mcp-gateway\` | 从 npm 安装的外部 MCP 插件仓储（拥有独立的 `package.json`） |
| **State** | `XDG_STATE_HOME` | `C:\Users\root\.local\state\mcp-gateway\` | 动态状态与运行时持久化日志 `logs\gateway.log` |
| **Cache** | `XDG_CACHE_HOME` | `C:\Users\root\.cache\mcp-gateway\` | 规范文档缓存与瞬态运行时数据 |

---

## 三、 配置体系与变量插值引擎

配置文件采用 **JSON5** 格式，由 Bun 原生引擎解析，原生支持注释、尾随逗号与单引号。

### 1. 动态插值语法
配置文件中的路径参数支持环境变量动态插值，提升跨机可移植性：
- `${APP_DATA_DIR}`：直接指向当前应用的专属数据区（即 `XDG_DATA_HOME\mcp-gateway`）。
- `${XDG_DATA_HOME}`、`${XDG_CONFIG_HOME}` 等：指向系统标准 XDG 根路径。
- `%USERPROFILE%`、`${HOME}`：展开为操作系统用户家目录。

### 2. 标准配置样例 (`config.json5`)
```json5
{
    mcpServers: {
        // 1. 本地原生二进制 MCP 节点
        codebase_memory: {
            command: "%USERPROFILE%/.local/bin/codebase-memory-mcp.exe",
            args: [],
            env: {},
        },

        // 2. 独立纳管于 XDG_DATA_HOME 的串流 MCP 节点
        drawio: {
            command: "bun",
            args: [
                "run",
                "${APP_DATA_DIR}/node_modules/@next-ai-drawio/mcp-server/dist/index.js",
            ],
            env: {
                PORT: "6002",
            },
        },
    },

    // 网关监听端口与地址
    host: "127.0.0.1",
    port: 9090,
}
```

---

## 四、 外部 npm MCP 插件管理指南

本工程代码库内**严禁直接安装业务型 MCP 扩展包**。所有通过 npm / bun 下载的外部 MCP 统一在数据层集中管理。

### 1. 物理位置
`C:\Users\root\.local\share\mcp-gateway\`

### 2. 插件安装与更新命令
在 PowerShell 中切换至该目录进行操作：
```powershell
# 切换至数据层物理目录
cd $env:XDG_DATA_HOME\mcp-gateway

# 安装新的 MCP 服务包
bun add <mcp-package-name>

# 升级已有 MCP 服务包
bun update @next-ai-drawio/mcp-server
```

---

## 五、 工程启动、构建与验证

### 1. 启动命令
```powershell
# 开发热执行模式
bun run dev

# 生产常驻启动模式
bun run start

# 编译为单文件原生 Windows 可执行文件
bun run build
# 产物生成于: build/mcp-gateway.exe
```

### 2. 自动化端到端测试
运行内置的断言测试脚本，验证健康检查、服务握手与反向代理 Origin 对齐：
```powershell
.\ps1_scripts\test-gateway.ps1
```

### 3. 持久化日志观测
日志自动落盘至 XDG 规范的状态目录中：
```powershell
Get-Content "$env:XDG_STATE_HOME\mcp-gateway\logs\gateway.log" -Tail 30 -Wait
```

---

## 六、 外部客户端对接指南 (Open WebUI)

### 1. 网络接入路由
当外部客户端通过 Caddy（`:8444`）反向代理接入时，网关会自动解析 `X-Forwarded-*` 请求头，确保 OpenAPI 文档中的 `servers.url` 准确生成为外部访问基准地址。

在 Open WebUI「管理面板」->「函数 / 工具 / OpenAPI」中注册：
- **Codebase Memory 接口**：
  `http://100.81.173.80:8444/codebase_memory/openapi.json`
- **Next AI Draw.io 接口**：
  `http://100.81.173.80:8444/drawio/openapi.json`

### 2. 契约规范特性
- **无命名污染**：生成的 `operationId` 严格与原始工具名完全一致（消除 `tool_*_post` 前后缀污染）。
- **参数标准挂载**：所有工具入参准确挂载在 `requestBody.content['application/json'].schema` 下，满足 OpenAPI 3.1.0 标准。
```

---

### 四、 快速生效步骤

1. 执行解耦部署脚本：
   ```powershell
   .\ps1_scripts\SetupDataMcp.ps1
   ```
2. 执行端到端测试断言：
   ```powershell
   .\ps1_scripts\test-gateway.ps1
   ```

