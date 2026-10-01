# open-mcp-gateway — 架构决策记录（ADR）

> 版本：v3.1（本地 CI 门禁体系）· 2026-10-01
> 变更摘要：新增决策 23（scripts/regress.ts 单入口回归 + pre-commit 门禁，与 OTT DECISIONS 25 同构对齐）；STACK 部署行与架构图会话池列表明同步至决策 22 终态（2026-10-01 外部写入收编，内容与决策 22 一致）。

## PURPOSE

MCP 协议至 OpenAPI 3.1.0 REST 网关：为 Open WebUI 等消费端提供统一的工具聚合与访问层。核心职责为通用的 MCP 协议桥接及图像格式内容协商，不包含任何消费端专属业务逻辑。

## STACK

- 运行时环境：Bun（`bun run src/index.ts`）
- 部署模式：Servy 托管服务 `omg-svc` → `~/.local/bin/omg.exe`（构建产物经 postbuild 钩子软链接暂存），服务账户 root，健康监视 `RestartProcess` 无限拉起
- 配置规范：遵循 XDG 目录规范与环境变量插值机制（支持 `%VAR%` 与 `${VAR}`）
- 传输协议：上游仅支持 `stdio` 与 `sse`（不支持 Streamable HTTP）

## ARCHITECTURE

```
消费端（OWUI 等）
  │ HTTP POST /{server}/{tool}
  ↓
gateway.ts — 路由 + 工具上下文注入（X-Tool-Context-* → body.chat_id/user_message_id）
  │ MCP stdio
  ↓
MCP 会话池（mcp/pool.ts）── codebase_memory / drawio / repomix / browser_governance
```

- `src/server/gateway.ts`：HTTP 路由调度、OpenAPI 规范生成、工具调用转发及图像格式协商
- `src/server/image-shape.ts`：MCP 图像块格式协商（支持 `inline` 原生 `data:` URI、`raw` 裸二进制字节流、`envelope` JSON 封装三态）
- `src/config/loader.ts`：JSON5 配置文件解析、环境变量插值及文件热重载（300 毫秒防抖）
- `src/mcp/pool.ts`：MCP 会话连接池（支持蓝绿平滑重载与优雅停机）
- `src/openapi/generator.ts`：动态生成 OpenAPI 3.1.0 规范文档

## DECISIONS

1. 传输边界：上游协议仅支持 `stdio` 与 `sse`；所有工具统一映射为 OpenAPI 3.1.0 REST 接口（每个工具对应 `POST /{server}/{tool}` 端点）。
2. 通道规范：`stdout` 专用于 MCP 协议通信，诊断与日志输出统一通过 `stderr` 记录；工具执行失败统一以 MCP `isError` 规范返回。
3. 配置规范：`config.json5` 仅负责引用变量插值（`%VAR%` 与 `${VAR}`），系统及用户环境变量统一由服务配置 XML 的 `<env>` 节点供给；Windows 文件路径一律使用正斜杠（`/`）。
4. 图像格式三态协商（`image-shape.ts`）：`inline`（默认，`data:` URI）、`raw`（`Accept: image/*`，裸二进制）与 `envelope`（`Accept: application/json` 或功能开关关闭，JSON 封装）；消费端经 `extract_base64_images` 转当轮 `input_image`。
5. 并发控制契约：`AsyncMutex` 设计为不可重入（相同键嵌套调用引发死锁属于符合预期的行为约束，已通过回归测试固化）。
6. 会话池蓝绿重载：`pool.addServer` 采用先建新会话、后关旧会话策略；新会话初始化失败时禁止覆盖处于 `READY` 状态的旧会话。
7. 日志输出规范：默认日志级别为 `INFO`；文件日志采用按文件体积滚动归档策略（roll-by-size）。
8. 网关服务化形态（已被决策 20 取代）：WinSW 系统服务，XML `<env>` 注入 XDG、用户目录、CBM 与 OWUI 变量。
9. 配置文件热重载：文件监听机制采用 300 毫秒防抖处理后触发 `pool.reconcile`（比对语义见决策 21）。
10. 上游独占资源冲突处理：BGM WebSocket 9095 端口出现单例冲突时，捕获 `EADDRINUSE` 错误并判定为非致命异常，按 250 毫秒间隔重试。
11. 接口耦合裁决：OTT 服务的 `/openapi.json` 规范保留三个只读操作定义（执行接口保持关闭）。
12. 客户端直连工具执行通道：`X-Session-Id` 等同于 `chat_id`（经前端 `executeTool` 机制验证）；`X-OpenWebUI-*` 请求头仅由服务端生成。
13. 外部 API 工具调用循环：请求体含 `chat_id`、`session_id`、`message_ids`、`user_message`、`parent_id` 时触发异步扇出执行；缺失 `message_ids` 则回退同步单轮。
14. 工具执行结果图像通道：`extract_base64_images` 仅执行正则完整匹配（`BASE64_IMAGE_DATA_URI_RE`）；工具消息不承载独立图像部件，多模态输入依赖 `process_tool_result` 转换为 `input_image`。
15. 无头场景挂载上下文恢复：解析 `X-Session-Id`（即 `chat_id`）与 `current_message_id` 挂载至 `message.files`；孤立文件约 6 分钟后由 `function_auto_delete_orphaned_chat_files_images` 清理。
16. Codebase Memory 组件治理：升级至 0.11.0 版本并在 SYSTEM 账户下实施私有部署，配合 `loader.ts` 环境变量插值能力，修复底层信任子系统安全限制（PR #2139 与 PR #2188）。
17. （2026-09-26）R3 上下文传递链路：Open WebUI 连接配置经 `{{CHAT_ID}}`/`{{USER_MESSAGE_ID}}` 注入 `X-Tool-Context-*` 请求头，`gateway.ts` 转为工具参数 `chat_id`/`user_message_id`，由 `pwsh-mcp` 消费；定位请求头缺失根因为 `ENABLE_FORWARD_USER_INFO_HEADERS` 默认禁用且元数据缺 `message_id` 键。
18. （2026-09-26）架构解耦重构：移除 `owui-attach.ts`、`OwuiAttachConfig` 及配置 `owui` 节（消除明文令牌风险）；网关恢复通用协议桥接层，`message.files` 挂载由 `capture_and_upload` 自闭环承载；`attach` 模式更名为 `inline`。
19. （2026-09-27）部署与开发分离：生产运行改用 `build` 单文件二进制（`bun build --compile --minify --bytecode`）；配置发现 `MCP_OPEN_GATEWAY_CONFIG` → `cwd/config.json5` → `{configHome}/config.json5|.json`，部署须固定前者；实测插值正确、冷启动 547–555 ms、缺配置仅告警绑默认 9090。
20. （2026-09-27）运行形态迁移：WinSW 退役，改由用户计划任务 `omg-run`/`ott-run` 承载（`ONLOGON` 免密、时限无限、失败重启 1 分钟 × 3 次）；网关以单文件二进制运行于 root，环境取自 root HKCU（`env-init.ps1` 写入）；CBM 随迁 `~/.local/share/cbm` 与 `~/.cache/cbm`（勿设 `CBM_RUNTIME_DIR`）。脱钩重启走 `services-switch`（`switch-tasks.ps1`）；切换须按端口强杀残留监听。
21. 服务挂载开关与配置比对语义：`enabled`（缺省开、显式 false 关）控制节点挂载——禁用不建会话，`/servers` 呈 `DISABLED`、路由返回 503；`pool.reconcile` 以键序无关深比较（`utils/equal.ts`）判定配置变更。

22. （2026-10-01）部署形态迁移 Servy 托管（与 OTT DECISIONS 24 同步，用户裁决）：计划任务 omg-run 退役为 Servy 托管服务 omg-svc（Servy 10.1，服务账户 .\root），托管对象为 ~/.local/bin/omg.exe——构建产物经 postbuild 钩子（scripts/stage.ts，SHA-256 新鲜度门）软链接暂存，开发 / 部署分离（硬链接因 bun 构建替换式落盘会陈旧，取软链接）。环境 10 项经 Servy --envVars 注入（XDG 四变量 + CBM 双路径 + OWUI_BASE / OWUI_TOKEN / GATEWAY_URL + MCP_OPEN_GATEWAY_CONFIG 显式钉住，保持决策 19 首项语义）；OWUI_TOKEN 暂不作秘密项（capture_and_upload 留待重实现，不依赖）；健康监视 RestartProcess 无限拉起（心跳 30s × 3）。pwsh_mcp 节点已移除（用户执行 G1，2026-10-01 05:24），四池现实（codebase_memory / drawio / repomix / browser_governance）。运维：services-switch 任务与 switch-tasks.ps1 退役归档（switch-archive/），restart-svc.ps1 入役（omg-svc 可直调，ott-svc 须 WMI 派生脱离执行）；omg-run 停用保留为回退资产。验证：重启实效（新旧 PID 交接、旧树清理、3 742 ms 四池 ALL_READY）、探针门全绿。

23. （2026-10-01）本地 CI 门禁体系（与 OTT DECISIONS 25 同构，用户裁决「在 OMG repo 也执行同样的操作」）：

    （a）单入口回归脚本 `scripts/regress.ts`：三段门串行——G1 类型门（`node_modules/.bin/tsc.exe --noEmit` 先行）→ G2 测试门（`bun test` 全量，判据固定为用例数 + 0 fail，基线 31 用例实测 2026-10-01）→ G3 探针门（`curl.exe --noproxy '*'`——缺陷 3；P1 GET /servers 全部池 READY 且池数 ≥ 4，判定语义参照 restart-svc.ps1 的 omg-svc 就绪门；P2 GET /health status=ok；OMG 无 Bearer 鉴权——《双机四流》§四.4，故无凭据段）。负向注入经 `--probe-base-url` 指向闭端口；退出码 0/1/2；缺省短路 + `--continue`；package.json 增 `regress` 映射。验证：正向 3/3 gates（cases=31、P1=200/ALL_READY(4)）+ 负向 G3 FAIL 退出码 1（实测）。提交 `816af77`。

    （b）pre-commit 门禁 `scripts/pre-commit`（POSIX sh，git hook 属 OS 必需接口）：tsc --noEmit 先行 + 快测子集（bun test；`TEST_FILTER` 环境变量按路径子串收窄，缺省全量——现行套件即快测规模），失败即拒绝提交；安装 `git config core.hooksPath scripts`（仓库本地配置，钩子本体随仓版本化）。验证：负向（无匹配过滤器 + --allow-empty）被拒退出码 1 无残余；正向经提交全量门禁实跑通过。仅本地开发流有效（无 push 场景）。提交 `25b9141`。

    （c）更正记录：提交 aa39656 提交信息中「test-gateway.ts import 未声明依赖 yoctocolors 不可运行」的判词取证有误——该依赖实际声明于本仓 dependencies（yoctocolors ^2.1.1）；该脚本删除依据以断言过时（2 池 / 静态 IP Origin，与四池现实不符）与误杀 9090 生产端口为准，删除结论不变（于提交 816af77 正文明示）。

## CURRENT_FOCUS

- R3 工件管道、单文件二进制部署与运行形态迁移均已验证完成（2026-09-27）；WinSW 已退役（旧件归档 `Service/winsw-archive/`）。
- 下一步：任务 1（`find_tab`）→ 5（Streamable HTTP）→ 4（工程治理）→ 界面端验收 → 1.0.0 发布。

## KNOWN_BUGS

- BGM 9095 端口若被非相关外部进程长期占用，将导致 WebSocket 桥接服务不可用（输出 `stderr` 告警并持续进入 250 毫秒重试循环）。
- `README.md` 与 `doc/README.self.md` 中针对上游传输协议的描述仍提及「HTTP」，与系统实际判别联合（`stdio` + `sse`）不符。

## COMMANDS

- 自动化测试：`bun test`；静态类型检查：`node_modules/.bin/tsc.exe --noEmit`（依赖项目级 TypeScript 7.0.2）
- 生产构建：`bun run build`（输出单文件二进制 `build/open-mcp-gateway.exe`）；开发环境启动：`bun run start`
- 服务重启（决策 22）：`~/.config/open-mcp-gateway/Service/restart-svc.ps1`（omg-svc 可直调，ott-svc 须 WMI 派生脱离执行）；日志 `~/.local/state/open-mcp-gateway/restart.log`；`switch-tasks.ps1` 已归档 `switch-archive/`
- 运行时状态查询：`GET http://127.0.0.1:9090/servers`（查询连接池状态）；工具调用执行：`POST http://127.0.0.1:9090/{server}/{tool}`
