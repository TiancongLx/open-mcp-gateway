# AGENTS.md — open-mcp-gateway (OMG)

> 深度上下文：`manage_adr(project='open-mcp-gateway')`；环境与拓扑见 Notes《热启动索引》。（v1.0 · 2026-09-23）

## 这是什么

MCP↔OpenAPI 3.1.0 聚合网关：聚合本地 stdio / sse MCP Server，向 Open WebUI 暴露 OpenAPI 3.1.0 REST（`/openapi.json`）。OWUI 经 **OpenAPI Servers** 挂载——**不是** MCP (Streamable HTTP)，上游也**没有** Streamable HTTP（仅 stdio + sse）。

## 常用命令

- `bun run start` — 启动（= `bun run ./src/index.ts`）
- `bun test` — 测试
- `bun run build` — 编译产物 `build/open-mcp-gateway.exe`（--compile --target=bun-windows-x64）
- `tsc --noEmit` — 类型检查（tsc 7.0.2 = Go 原生编译器；无 tsgo）

## 架构速览

- `src/config/types.ts` — `McpServerConfig` = `StdioServerConfig | SseServerConfig`（`isStdioConfig` / `isSseConfig`）
- `src/openapi/generator.ts` — `OpenApiGenerator.generate` → `openapi: '3.1.0'`，每工具 `POST /{toolName}`
- `src/mcp/` + `src/pool/` — 上游会话与连接池；`src/server/` — HTTP 服务；`src/utils/logger.ts` — 日志

## 约定与陷阱

- **stdout 是协议通道，诊断一律走 stderr**
- 上游传输只有 stdio / sse 两种配置形态——加 Streamable HTTP 前先更新本文件与 ADR
- 配置走 XDG + 变量插值（`src/config/xdg.ts`）；`.env` 不入库
- Windows 进程清理：`taskkill /PID <pid> /T /F`
