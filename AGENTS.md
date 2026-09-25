# AGENTS.md — open-mcp-gateway（OMG）

> 深度上下文用 `manage_adr(project='open-mcp-gateway')` 读取，环境与拓扑见笔记《环境索引》。（v1.2 · 2026-09-24）

## 这是什么

这是一个 MCP 聚合网关。本地的 MCP Server 以 stdio 或 sse 接入进来，网关把它们的工具统一包装成 OpenAPI 3.1.0 的 REST 接口，对外提供 `/openapi.json`，由 Open WebUI 经 OpenAPI Servers 挂载使用。

这里没有 MCP 直通。Open WebUI 一侧拿到的是 REST，上游一侧也只有 stdio 和 sse 两种形态，没有任何 Streamable HTTP 的实现。这两点容易记反，动传输相关代码前先回来确认一句。

## 常用命令

- `bun run start` 启动开发版，等同 `bun run ./src/index.ts`
- `bun test` 跑测试
- `bun run build` 编译单文件产物 `build/open-mcp-gateway.exe`（`--compile --target=bun-windows-x64`）
- `tsc --noEmit` 做类型检查。这里的 tsc 是 Go 原生编译器，版本 7.0.2，和 npm 生态的 tsc 不是一个东西，本机也没有 tsgo

## 架构速览

配置定义在 `src/config/types.ts`。`McpServerConfig` 是 `StdioServerConfig` 与 `SseServerConfig` 的联合类型，配套 `isStdioConfig` 和 `isSseConfig` 两个判别函数。路径解析和变量插值在 `src/config/xdg.ts`。

OpenAPI 生成器在 `src/openapi/generator.ts`。`OpenApiGenerator.generate` 返回 `openapi: '3.1.0'` 的规格文档，每个工具映射成一条 `POST /{toolName}` 路由。

其余部分：`src/mcp/` 和 `src/pool/` 管上游会话与连接池，`src/server/` 是 HTTP 服务，`src/utils/logger.ts` 管分级日志和文件日志。

## 约定与陷阱

stdout 是协议通道，诊断信息一律走 stderr，往 stdout 打印任何多余的东西都会破坏协议。工具执行失败时返回 MCP 的 `isError` 结果，不要在协议层抛异常。单图像块结果默认整形为托管媒体描述符 `{screenshot, render}`（模型以 markdown 嵌入回复正文，机制同 AIHubMix；OWUI 会把 `data:` 图像分流为「仅喂模型」，勿退回裸 data URI 路线），三态协商见 `src/server/image-shape.ts`：服务级开关 `owuiImageCompat`（缺省开、显式 false 关）+ `Accept: application/json` 信封逃生口 + `Accept: image/*` 裸字节；文本类结果恒为 JSON 信封，不要扩大整形范围。

配置走 XDG 加变量插值，`.env` 不入库。将来如果要加 Streamable HTTP 传输，先把本文件和 ADR 更新了再动代码。

在 Windows 上清理进程用 `taskkill /PID <pid> /T /F`。
