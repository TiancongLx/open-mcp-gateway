# AGENTS.md — open-mcp-gateway（OMG）

> 深度上下文：`doc/adr/`（本地化 ADR，git 为唯一版本载体）；环境与拓扑见 `terminal:env-local` 技能。（v1.10 · 2026-10-16）

## 这是什么

MCP 聚合网关：本地或远程 MCP Server 以 `stdio` / `sse` / `streamable-http` 接入，其工具统一包装为 OpenAPI 3.1.0 REST（每工具 `POST /{server}/{tool}`），由 Open WebUI 经 OpenAPI Servers 挂载使用。

没有 MCP 直通。上游一侧支持 `stdio`、`sse` 与 Streamable HTTP（`transport: 'streamable-http'`）三种形态——动传输相关代码前先回 `doc/adr/` 确认。配置 `config.json5` 支持 `%VAR%` 与 `${VAR}` 插值（含 url / headers）并热重载（300 ms 防抖）。远程池具备退避重连自愈（`reconnect: false` 可关；决策 25）。生产池五态：本地三池（codebase_memory / drawio / repomix）+ GitHub / Context7（Streamable HTTP，经 Xray 出口；密钥经服务环境注入，勿硬编码）。

## 常用命令

- `bun run start` 开发启动；`bun test` 测试；`node_modules/.bin/tsc.exe --noEmit` 类型检查（tsc 为 Go 原生编译器 7.0.2，无 tsgo）
- `bun run build` 单文件二进制 `build/open-mcp-gateway.exe`
- 运行时状态：`GET http://127.0.0.1:9090/servers`；工具调用：`POST http://127.0.0.1:9090/{server}/{tool}`
- 统一目录（决策 24）：规格 `GET http://127.0.0.1:9090/omg/openapi.json`；检索 `POST http://127.0.0.1:9090/omg/tools/search`；调度 `POST http://127.0.0.1:9090/omg/tools/call`

## 架构速览

- `src/server/gateway.ts` — HTTP 路由、OpenAPI 生成、工具转发与图像协商
- `src/mcp/pool.ts` — 会话池（蓝绿重载、优雅停机、`enabled` 禁用登记簿）
- `src/mcp/session.ts` — 单服务 MCP 会话（stdio/sse/streamable-http；远程池退避重连监督）
- `src/config/loader.ts` — JSON5 解析、变量插值、文件热重载
- `src/openapi/generator.ts` — OpenAPI 3.1.0 规范生成
- `src/openapi/catalog.ts` — 统一工具目录入口（/omg：search_tools / call_tool；服务枚举 / 错误 schema 回挂 / 清单内容指纹；决策 24）
- `src/utils/equal.ts` — 键序无关深比较（reconcile 配置比对）

## 约定与陷阱

- `stdout` 是协议通道，诊断一律走 `stderr`；工具执行失败返回 MCP `isError`，不在协议层抛异常
- 图像整形三态（`src/server/image-shape.ts`）：`inline`（缺省）裸 `data:` URI、`raw`（`Accept: image/*`）裸字节、`envelope` JSON 信封；文本类结果恒为信封，勿扩大整形范围
- 配置文件路径一律正斜杠（JSON 转义吃单反斜杠）；`enabled: false` 的服务不建会话（`/servers` 呈 `DISABLED`、路由 503）
- 服务重启走脱离式 `~/.config/open-mcp-gateway/Service/restart-svc.ps1`（omg-svc 可直调，ott-svc 须 WMI 派生脱离执行；细节见 env-local「运维指令」）

## 验证

- `bun test` + `tsc --noEmit` 全绿；改动配置后看 `GET /servers` 五池 `READY` 且 `lastError` 为空（就绪门判据 ≥5，五池现实 2026-10-13 起）
