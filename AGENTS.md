# AGENTS.md — open-mcp-gateway（OMG）

> 深度上下文：`doc/adr/`（本地化 ADR，git 为唯一版本载体）；环境与拓扑见 `terminal:env-local` 技能。（v1.5 · 2026-09-27）

## 这是什么

MCP 聚合网关：本地 MCP Server 以 `stdio` 或 `sse` 接入，其工具统一包装为 OpenAPI 3.1.0 REST（每工具 `POST /{server}/{tool}`），由 Open WebUI 经 OpenAPI Servers 挂载使用。

没有 MCP 直通。上游一侧只有 `stdio` 与 `sse` 两种形态，没有 Streamable HTTP——动传输相关代码前先回 `doc/adr/` 确认。配置 `config.json5` 支持 `%VAR%` 与 `${VAR}` 插值并热重载（300 ms 防抖）。

## 常用命令

- `bun run start` 开发启动；`bun test` 测试；`node_modules/.bin/tsc.exe --noEmit` 类型检查（tsc 为 Go 原生编译器 7.0.2，无 tsgo）
- `bun run build` 单文件二进制 `build/open-mcp-gateway.exe`
- 运行时状态：`GET http://127.0.0.1:9090/servers`；工具调用：`POST http://127.0.0.1:9090/{server}/{tool}`

## 架构速览

- `src/server/gateway.ts` — HTTP 路由、OpenAPI 生成、工具转发与图像协商
- `src/mcp/pool.ts` — 会话池（蓝绿重载、优雅停机、`enabled` 禁用登记簿）
- `src/mcp/session.ts` — 单服务 MCP 会话（stdio/sse）
- `src/config/loader.ts` — JSON5 解析、变量插值、文件热重载
- `src/openapi/generator.ts` — OpenAPI 3.1.0 规范生成
- `src/utils/equal.ts` — 键序无关深比较（reconcile 配置比对）

## 约定与陷阱

- `stdout` 是协议通道，诊断一律走 `stderr`；工具执行失败返回 MCP `isError`，不在协议层抛异常
- 图像整形三态（`src/server/image-shape.ts`）：`inline`（缺省）裸 `data:` URI、`raw`（`Accept: image/*`）裸字节、`envelope` JSON 信封；文本类结果恒为信封，勿扩大整形范围
- 配置文件路径一律正斜杠（JSON 转义吃单反斜杠）；`enabled: false` 的服务不建会话（`/servers` 呈 `DISABLED`、路由 503）
- 服务重启走脱钩式 `schtasks /Run /TN services-switch`（细节见 env-local「运维指令」）

## 验证

- `bun test` + `tsc --noEmit` 全绿；改动配置后看 `GET /servers` 各池 `READY` 且 `lastError` 为空
