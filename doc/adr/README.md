# open-mcp-gateway — 架构决策记录（ADR）

> 版本：v3.7（检索计数显式化 · 部署入账）· 2026-10-14
> 变更摘要：新增决策 26（S2 · SaaS 池接入：GitHub / Context7 折入 OMG + instructions 保真 + 就绪门 ≥5 + OWUI 单连接收敛）；S2 全链已部署验证（2026-10-13）；AGENTS.md v1.9 同步；决策 24（l）检索响应计数显式化（2026-10-14 实现并部署入账，产物 `304ff32c…`）。

## PURPOSE

MCP 协议至 OpenAPI 3.1.0 REST 网关：为 Open WebUI 等消费端提供统一的工具聚合与访问层。核心职责为通用的 MCP 协议桥接及图像格式内容协商，不包含任何消费端专属业务逻辑。

## STACK

- 运行时环境：Bun（`bun run src/index.ts`）
- 部署模式：Servy 托管服务 `omg-svc` → `~/.local/bin/omg.exe`（构建产物经 postbuild 钩子软链接暂存），服务账户 root，健康监视 `RestartProcess` 无限拉起
- 配置规范：遵循 XDG 目录规范与环境变量插值机制（支持 `%VAR%` 与 `${VAR}`）
- 传输协议：上游支持 `stdio` / `sse` / `streamable-http` 三态（决策 25，S1 批次起）

## ARCHITECTURE

```
消费端（OWUI 等）
  │ HTTP POST /{server}/{tool}
  ↓
gateway.ts — 路由 + 工具上下文注入（X-Tool-Context-* → body.chat_id/user_message_id）
  │ MCP stdio
  ↓
MCP 会话池（mcp/pool.ts）── codebase_memory / drawio / repomix（三池现实 2026-10-11 起）
```

- `src/server/gateway.ts`：HTTP 路由调度、OpenAPI 规范生成、工具调用转发及图像格式协商
- `src/server/image-shape.ts`：MCP 图像块格式协商（支持 `inline` 原生 `data:` URI、`raw` 裸二进制字节流、`envelope` JSON 封装三态）
- `src/config/loader.ts`：JSON5 配置文件解析、环境变量插值及文件热重载（300 毫秒防抖）
- `src/mcp/pool.ts`：MCP 会话连接池（支持蓝绿平滑重载与优雅停机）
- `src/mcp/session.ts`：单服务 MCP 会话（stdio / sse / streamable-http；远程池退避重连监督）
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

    （d）更正记录（2026-10-13，目录批次回归实测暴露）：P1 池数下限随 browser_governance 移除后的三池现实由「≥4」更正为「≥3」——`scripts/regress.ts` 同步修正并 CASE_BASELINE 31 → 43（提交 `9a1ce83`）；`~/.config/open-mcp-gateway/Service/restart-svc.ps1` 就绪门同步修正（备份 `restart-svc.ps1.bak-20261013-poolcount` 在册；修正后 regress 3/3 PASS 实测）。

24. （2026-10-13）统一工具目录入口（catalog face：/omg 的 search_tools / call_tool；组合 A 命名；实现批次提交 `1a9afcf` + `9aff62f`）：

    （a）动因：OWUI Tool Search 实验特性在本机严格函数解码栈上不可用（延迟工具无法按名调用、静默失效；上游 #32243 裁决为设计取舍），上下文节省目标改由网关侧自研承载。设计不变式三条：① 模型可调用的名字恒为已声明工具（严格栈安全）；② 大 schema 以「工具结果」按需返回（提示词缓存前缀不被改写）；③ provider `tools` 数组随池状态稳定。

    （b）形态：新增保留命名空间 `/omg`（`mcpServers` 若占用该名则启动告警并遮蔽——当前三池无冲突；启动检查 + 路由侧惰性告警双保险）。新增：`GET /omg`、`GET /omg/openapi.json`（统一 compact 规格，两路径同构）；`POST /omg/tools/search`（operationId `search_tools`）；`POST /omg/tools/call`（operationId `call_tool`）。本版无配置面（纯增量路由；开关与参数化后续按需裁决）。旧三池路径（`/{server}`、`/{server}/openapi.json`、`POST /{server}/{tool}`）行为零变更。

    （c）语义：search 入参 `{query, count?}`——精确工具名直返命中（跨池同名时全量返回以消歧），否则按加权重叠排名（name×3 / 服务名×2 / 参数名×2 / description×1；camelCase 拆分 + CJK 二元组），`count` 缺省 5、上限 20（对齐 OWUI Tool Search 参数语义）；返回 `{tools: [{server, name, description, input_schema}], unavailable_servers: [...]}`，仅含 READY 池命中并附不可用池提示。call 入参 `{tool, arguments?, server?}`——`server` 缺省时按名跨池解析（0 命中返回候选提示 / 1 命中直调 / 多命中返回歧义列表）；执行复用会话池 `callTool` 与图像三态协商，`X-Tool-Context-*` 透传；HTTP 状态语义：未就绪或禁用 503（CONNECTING 附 `Retry-After: 2`）、未知工具或歧义 400、未知服务器 404、异常 500。`search_tools` 描述内嵌「服务: 工具名」清单（预算 ~0.7 kB）——清单于 spec 缓存时刻生成（配置态快照）；搜索与调用实时。

    （d）规模与兼容：三池全量工具定义快照 33,770 字符 → 统一入口目标 ≤3 kB（约 -93%；实测随部署批次回填）。OWUI 侧迁移：新增 `/omg` 连接（`http://redmi:8444/omg`，path `openapi.json`）→ 验收 → 禁用旧三连接；回滚 = 反向操作，毫秒级，无数据迁移。

    （e）命名裁决（用户 2026-10-12）：短名归聚合枢纽（OMG = `search_tools` / `call_tool`）；OTT 对应取名 `search_terminal_tools` / `call_terminal_tool`（阶段 2 实施）。背景：OWUI 工具名跨连接全局唯一、重名静默去重——短名不可三池各持一份，统一入口为唯一自洽形态。

    （f）已知风险：① 与未来重开 OWUI Tool Search 时其内置 `search_tools` 存在撞名可能（该特性当前关闭；重开时另行裁决）；② `arguments` 嵌套对象在严格栈的生成能力属本批次首个上线验收项，后备形态 `arguments_json`（字符串）预案在案；③ 首次调用某工具可能多一轮（清单 + 错误引导缓解）。

    （g）验证：`tests/catalog.rank.test.ts`（11 用例：分词/精确名/权重/CJK/count/形状/manifest）+ `tests/catalog.http.test.ts`（HTTP 集成：规格结构、检索双形态、跨池分发、消歧、歧义/未知/404/503、图像三态、方法面）；门禁 tsc + `bun test`（31 → 43 用例全绿）+ `bun run regress` 三段门 3/3 PASS（P1=200/ALL_READY(3)，2026-10-13 实测）。

    （h）离线场景条款（2026-10-13 补录）：本机双服务 Down、OWUI 在线时——① 折叠后 OMG/OTT 死重量由 ~46.7 千字符降至 ~5–7 kB 预期上限（OMG ≤3k + OTT 1.5–3.7k，随部署实测回填）；② 离线死工具名片数 43 → 6（4 meta + OTT 白名单 2，OTT 属阶段 2）；③ 离线期 OWUI 重启后需重存连接（保存连接/重启）以回载；终端选中会话 503 硬失败属 OWUI 既有行为（CHTR-0001 §一 a4，操作时避开）；④ search/call 的 READY 门控与 503 语义见（c），避免返回死工具诱发死调用。

    （i）部署与 OWUI 接线入账（2026-10-13）：产物 `128ace6f…`（99,875,328 B）经 stage 软链入役，omg-svc 重启就绪门 `ALL_READY`（4.9 s），regress 3/3；OWUI 侧接线顺序为——新增 OMG 连接（`http://redmi:8444/omg`，spec 3,315 B，容器视角拉取核验）→ 五模型 toolIds `server:CBM` → `server:OMG` → 同窗口禁用 Firecrawl（关闭、保留条目与密钥）与三池连接。实测回填：三池工具定义 33,770 → 统一入口 1,826 字符（-94.6%）；每次保存后的 OWUI 拉取链经 OMG 日志核验（17:35:49 四规格；17:37:00 仅 /omg）。回滚 = 连接备份 `owui-connections-pre-wire1/pre-wire2.json` 与模型备份 `owui-models-pre-swap.json` 回灌 + 模型引用回切；二进制回滚 = `omg.exe.bak-20261013-pre-catalog`。同日稍后：用户于面板彻底删除 Firecrawl 与三池连接条目（连接面收敛为 github / context7 / OMG 三条；模型侧悬空引用 firecrawl / greptile 清理，留档 `owui-models-pre-refclean.json`）；首验项（严格栈嵌套 `arguments`）实测通过——验收聊天「codebase_memory 工具查询」内 `call_tool` 两次嵌套实调成功。

    （j）目录人机工程迭代（2026-10-13，基于验收会话的 LLM 复盘评估）：① search_tools 增 `server` 枚举语义——显式 `server` 参数（query 缺省即枚举）或查询词恰为 READY 服务名（便利语义）时，返回该服务全部工具（按名排序；缺省全量、显式 count 截断，安全上限 100）；② 检索响应附 `generated_at`、快照清单附生成时间戳（漂移可辨识）；③ call 失败（MCP `isError` 结果或调用异常）自动补挂该工具 `input_schema`（自修复不依赖重搜）；④ 零命中附枚举提示。测试：新增枚举/作用域/错误回挂/提示用例（套件 49 → 51，含既有断言扩展）。

    （k）交叉裁定更新（2026-10-13）：OTT 工具折叠裁定撤销（用户裁决；依据：消费端 `display_file` 三层按名特判、白名单扩容后净收益 ≈ -8%、避免与「按 OT 严格对齐」工作重复）——（e）中 `search_terminal_tools` / `call_terminal_tool` 命名不再实施；（h）中 OTT 部分修正为「全量直出」，合计实测随 T3 复测回填。裁量正文与账目见工具面测试计划 Note（T2 节）。

    （l）检索响应计数显式化（2026-10-14，实现入仓）：`search_tools` 响应新增 `count` 字段（= 返回工具条数；零命中为 0）——消除模型端手数误差（验收聊天「GitHub Tools Enumeration」实录：返回 46、模型自述 49）；规格 200 响应描述同步；测试断言扩展（精确检索 / 枚举 / 截断 / 零命中）。部署入账（2026-10-14）：产物 `304ff32c…`（stage 软链校验通过）；omg-svc 重启就绪门 `ALL_READY after 4411 ms`；冒烟（枚举 count=46 / 截断 count=2 / 零命中 count=0；规格 4,754 → 4,800 B）+ regress 3/3（P1=ALL_READY(5)）；OWUI 重存触发重取核验（OMG 日志 04:35:46 落痕）；回滚 = `omg.exe.bak-20261014-pre-count`（前产物 `ddabb246…`）。

25. （2026-10-13）Streamable HTTP 传输与远程池断连自愈（S1 批次；决策 24「任何形态 MCP 经 OMG 转 OpenAPI」的使能器；实现提交 `f59fc1f`）：

    （a）动因：SaaS 收编（GitHub / Context7；测试计划 Note 七·D「选择 A」）要求上游传输三态完备（stdio / SSE / Streamable HTTP 此前缺第三态）；远程池在网络波动、代理链路抖动与上游维护窗口下需要断连自愈，而非既有的「一次性连接」语义。

    （b）形态：节点配置新增 `StreamableHttpServerConfig`（判别字段 `transport: 'streamable-http'`；除 `url` / `headers` / `timeout` / `callTimeoutMs` / `enabled` / `owuiImageCompat` 外，含 `reconnect` / `reconnectMinDelayMs` / `reconnectMaxDelayMs`）；`loader.ts` 补 headers 插值面（认证头经 `%VAR%` / `${VAR}` 注入）。会话层经 SDK 1.30 `StreamableHTTPClientTransport` 接入，认证头经 `requestInit.headers` 透传；出口走全局 fetch（Bun 承接机器级 HTTP(S)_PROXY——Servy 服务上下文代理变量已实测在役）。旧两态（stdio / sse）行为零变更；判别分支置于 SSE 之前（规避结构收窄歧义）。

    （c）自愈语义（退避重连监督，仅 Streamable HTTP；`reconnect: false` 可关）：触发面三处——① 意外断连（Protocol onclose，READY 期判定）；② 调用期非超时异常（疑似传输故障，READY 期一次事件即入监督）；③ 初始连接失败（池保留会话对象不再判死刑，覆盖启动期网络/代理未就绪）。退避 min（缺省 1 s）翻倍至 max（缺省 60 s）、±20% 抖动；重连成功自动 `refreshTools` 并复位计数；监督期状态机复用 READY/CONNECTING/FAILED（`/servers` 与 `/omg` 的 READY 门控自动衔接）。`close()` 与池关停清退定时器与在途重连（`supervisionAbort`）。

    （d）池侧行为：`pool.addServer` 失败分支对自愈型会话（无旧会话 ∨ 旧会话非 READY）保留并注册入池、进入监督；旧会话 READY 时维持 P0-2 保护不合入。既有 stdio/sse 失败路径零变更。

    （e）验证：`tests/session.streamable.test.ts` 5 用例（连接/头部透传、断连检测 → 退避重连 → 恢复、初始失败自愈、reconnect:false 旧语义、401 负例）全绿；夹具 `tests/fixtures/streamable-server.ts`（Bun.serve + WebStandard stateless——SDK 1.30 要求每请求新建绑定；独立控制端口支持真实拒连/恢复）。全仓套件 44 → 49、tsc 0。同批次附带目录服务名检索域修正（提交 `f837b57`，权重回填见决策 24（c））。部署入账（2026-10-13）：产物 `3c0f8d90…`（99,932,672 B）经 stage 软链入役，omg-svc 重启就绪门 `ALL_READY`（3.8 s）；冒烟（枚举 17 工具 / 零命中提示 / 服务作用域检索）与 regress 3/3（cases=51）通过；OWUI 侧重存触发 spec 重取（OMG 日志 `GET /omg/openapi.json` 落痕核验，OWUI 侧零错误）。二进制回滚 = `omg.exe.bak-20261013-pre-ergonomics`（`128ace6f…`）；连接/模型回滚资产见决策 24（i）。SaaS 池接入（S2）另行报批（T2 确认制）。

26. （2026-10-13）SaaS 池接入与 OWUI 收敛（S2 批次；决策 24「选择 A 全折入 OMG」的落地；实现提交 `88a8ff3` + 判据提交 `ec802dd`）：

    （a）范围与动因（用户裁决 2026-10-13）：GitHub / Context7（原 OWUI 直连 MCP）折入 OMG 上游——OWUI 集成工具收敛为单一 `/omg` 连接（终态：模型+检索 = LiteLLM / 集成工具 = OMG / 终端 = OTT）。出口纪律：一律经 Xray（GitHub 直连不可预期；Bun fetch 走机器级 `HTTP(S)_PROXY`，Servy 服务上下文继承已实测）。

    （b）实现：两池 `transport: 'streamable-http'`（决策 25）+ 认证头 `Authorization: Bearer %GITHUB_MCP_KEY%` / `%CONTEXT7_MCP_KEY%`（loader headers 插值面）；instructions 保真——会话层捕获 MCP initialize `instructions`，`/omg/tools/search` 按命中服务附出 `server_instructions`（不常驻 spec / 系统提示）；manifest 预算 700 → 1700（五池 76 工具全名清单 ≈1.5k 字符）。

    （c）就绪门判据升级：`scripts/regress.ts` 与 `restart-svc.ps1` 池数下限 3 → 5（五池现实 2026-10-13 起；截断类配置故障可被捕获）；`restart-svc.ps1.bak-20261013-s2` 备份在册。

    （d）密钥注入（环境面，root HKCU 仍为值源）：GITHUB_MCP_KEY / CONTEXT7_MCP_KEY（值源 = OWUI 连接凭据，长度 40 / 43）——① root HKCU 就位（三源哈希互证）；② 服务环境快照经 Servy `import` 更新——源码级确认 `preserveExistingCredentials / preserveExistingRuntimeState: true` 恒开，账号 `.\root` 与其余 10 项环境零扰动（实测回读 12 项）；③ `install-omg-servy.ps1` envPairs +2（备份 `.bak-20261013-s2`；未来安装自洽）。服务环境前态备份：`omg-svc-env-pre-s2.json`。

    （e）验证（2026-10-13）：沙箱预演（独立 XDG，端口 9091）——两池实连（github 46 / context7 2 工具）+ instructions 保真（1,802 / 632 字符）+ 实调（`get_me` 1.73 s / `resolve-library-id` 2.92 s）；部署窗口（stop → config 1821→2576 B（备份 `config.json5.bak-20261013-s2`）→ Bun JSON5 解析门 → restart）——就绪门 `ALL_READY after 4261 ms`（五池：cbm 17 / drawio 5 / repomix 6 / github 46 / context7 2 = 76 工具）；`/omg` 规格 3,878 → 4,754 B；生产冒烟：`server_instructions.github` 1,802 字符随检索附出、`get_me` 0.57 s、`resolve-library-id` 1.52 s；regress 3/3（P1=200/ALL_READY(5)）。

    （f）OWUI 收敛（单保存窗口）：连接面 3 → 1（保留 `OMG`；删除 github / context7；OMG 对象 11 字段逐一 EQUAL，零归一化损伤）；七模型悬空引用清理（glm×2 / mimo×2 / deepseek → `[server:OMG]`；gemini / grounding-formalization-architect → `[]`；meta 其余键与 params 零变动）；保存触发 spec 重取（OMG 日志 `21:50:41 GET /omg/openapi.json` 落痕，OWUI 零错误）；全配置导出残留扫描零命中。回滚 = `owui-connections-pre-s2.json` + `owui-models-pre-s2.json` 回灌。

    （g）T3 实测回填（F1 口径，复刻 OWUI 转换）：/omg 可见载荷 search_tools 2,366 + call_tool 823 = 3,189 字符（S2 前同口径 2,313；历史 1,826 属 T1 首代 spec，代际不可直比）。工具区终值：OMG 3,189 + OTT 13,508 ≈ 16.7k 字符（对停 FC 后 72.6k ≈ −77%；对全工具面起点 161.3k ≈ −89.6%）；SaaS 净变化 = +876（manifest 28→76 工具）− 57,290（两连接移除）= −56,414；每消息 MCP 固定开销 github/context7 合计 4.6 s 归零；`cached_tokens` 回填（2026-10-14 验收聊天「GitHub Tools Enumeration」）：累计输入 84,750 / 缓存命中 50,496（≈59.6%）；验收：枚举 46/46 一次取齐 + `get_me` 成功，全程 23.5 s。

## CURRENT_FOCUS

- R3 工件管道、单文件二进制部署与运行形态迁移均已验证完成（2026-09-27）；WinSW 已退役（旧件归档 `Service/winsw-archive/`）。
- 目录面（决策 24）批次：catalog 内核 + /omg 接线 + 判据修正（23d）已入仓（提交 `1a9afcf` / `9aff62f` / `9a1ce83`；43 用例 + regress 3/3 门禁全绿）；部署已入账（产物 `128ace6f…`）——OWUI 接线完成：五模型引用切换、Firecrawl 关闭、三池禁用（备份留档在册）。
- S2 批次（决策 26）：已部署（产物 `ddabb246…`，五池就绪门 4.3 s；regress 3/3 / P1=ALL_READY(5)）；OWUI 收敛为单 /omg 连接（github / context7 已删除、模型引用清理完毕、spec 重取留痕核验）。待办：OTT「按 OT 严格对齐」批次（不单独立项，见工具面测试计划 Note）；T3 缓存已回填（验收聊天「GitHub Tools Enumeration」，见决策 26（g））。
- 检索计数显式化（决策 24（l））：实现 + 部署已完成（产物 `304ff32c…`，2026-10-14；冒烟 + regress 3/3 + OWUI 重存核验）。
- 下一步：任务 1（`find_tab`）→ 5（Streamable HTTP）→ 4（工程治理）→ 界面端验收 → 1.0.0 发布。

## KNOWN_BUGS

- BGM 9095 端口若被非相关外部进程长期占用，将导致 WebSocket 桥接服务不可用（输出 `stderr` 告警并持续进入 250 毫秒重试循环）。
- `README.md` 与 `doc/README.self.md` 中针对上游传输协议的描述仍提及「HTTP」，与系统实际判别联合（`stdio` + `sse`）不符。

## COMMANDS

- 自动化测试：`bun test`；静态类型检查：`node_modules/.bin/tsc.exe --noEmit`（依赖项目级 TypeScript 7.0.2）
- 生产构建：`bun run build`（输出单文件二进制 `build/open-mcp-gateway.exe`）；开发环境启动：`bun run start`
- 服务重启（决策 22）：`~/.config/open-mcp-gateway/Service/restart-svc.ps1`（omg-svc 可直调，ott-svc 须 WMI 派生脱离执行）；日志 `~/.local/state/open-mcp-gateway/restart.log`；`switch-tasks.ps1` 已归档 `switch-archive/`
- 运行时状态查询：`GET http://127.0.0.1:9090/servers`（查询连接池状态）；工具调用执行：`POST http://127.0.0.1:9090/{server}/{tool}`
