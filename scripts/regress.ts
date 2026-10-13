// scripts/regress.ts — OMG 本地 CI 主入口：tsc -> bun test -> 探针段（三段门串行）。
// 与 OTT 仓 scripts/regress.ts 同构（F-A 设计），探针段按 OMG 契约适配。
//
// 判据（缺陷 8：不断言 expect() 计数）：
//   G1 类型门：node_modules/.bin/tsc.exe --noEmit 退出码 0。
//   G2 测试门：bun test 退出码 0 且 fail=0 且用例数>0；用例数如实记录，低于基线仅告警。
//   G3 探针门：P1 池门（GET /servers，全部池 READY 且池数>=3——三池现实 2026-10-11 起，500 ms 轮询至 --probe-timeout；
//      判定语义参照 ~/.config/open-mcp-gateway/Service/restart-svc.ps1 的 omg-svc 就绪门）+
//      P2 健康契约（GET /health，status=ok）。
// 传输固定 curl.exe --noproxy '*'（缺陷 3：https_proxy 劫持本地回环）。OMG 无 Bearer 鉴权
// （原文拓扑笔记 §四.4），故无凭据段；负向注入经 --probe-base-url 指向闭端口验证门拦截。
// 退出码：0 = 三段全 PASS；1 = 存在 FAIL；2 = 脚本自身异常（工具缺失 / 参数错）。
// 缺省短路（任一段 FAIL 即终止，后续段记 SKIPPED），--continue 全段执行。
//
// 用法：bun run regress [-- --continue] [-- --probe-timeout <秒>] [-- --probe-base-url <url>]
// 负向注入示例：bun run regress -- --probe-base-url http://127.0.0.1:9 --probe-timeout 2

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');
const TSC = join(repoRoot, 'node_modules', '.bin', 'tsc.exe');
const CASE_BASELINE = 51; // 基线 51 用例（实测 2026-10-13，人机工程迭代后）；低于基线仅告警
const HTTP_MARK = '@@HTTP=';

type GateStatus = 'PASS' | 'FAIL' | 'SKIPPED';

interface GateResult {
    name: string;
    status: GateStatus;
    durMs: number;
    detail: string;
    tail?: string;
}

function fail2(msg: string): never {
    console.error(`regress: ${msg}`);
    process.exit(2);
}

// ---- 参数解析（防御式索引访问）----
let continueMode = false;
let probeTimeoutMs = 10_000;
let probeBaseUrl = 'http://127.0.0.1:9090';
const cliArgs = process.argv.slice(2);
for (let i = 0; i < cliArgs.length; i++) {
    const a = cliArgs[i];
    if (a === '--continue') {
        continueMode = true;
    } else if (a === '--probe-timeout') {
        const v = cliArgs[++i];
        const n = v === undefined ? NaN : Number(v);
        if (!Number.isFinite(n) || n <= 0) fail2('--probe-timeout 需要正数秒值');
        probeTimeoutMs = n * 1000;
    } else if (a === '--probe-base-url') {
        const v = cliArgs[++i];
        if (v === undefined) fail2('--probe-base-url 需要 URL');
        probeBaseUrl = v;
    } else {
        fail2(`未知参数：${String(a)}`);
    }
}
probeBaseUrl = probeBaseUrl.replace(/\/+$/, '');

async function run(cmd: string[]): Promise<{ code: number; out: string }> {
    try {
        const proc = Bun.spawn({ cmd, cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
        const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
        await proc.exited;
        return { code: proc.exitCode ?? -1, out };
    } catch (e) {
        return { code: -2, out: `spawn failed: ${String(e)}` };
    }
}

function tailLines(text: string, n: number): string {
    const lines = text.split('\n');
    return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

async function curlProbe(url: string): Promise<{ status: number; body: string; code: number }> {
    const cmd = ['curl.exe', '-s', '--noproxy', '*', '--max-time', '10', '-w', `\n${HTTP_MARK}%{http_code}`, url];
    const r = await run(cmd);
    const idx = r.out.lastIndexOf(`\n${HTTP_MARK}`);
    if (idx < 0) return { status: -1, body: r.out, code: r.code };
    const status = Number(r.out.slice(idx + 1 + HTTP_MARK.length).trim());
    return { status: Number.isFinite(status) ? status : -1, body: r.out.slice(0, idx), code: r.code };
}

const results: GateResult[] = [];
let anyFail = false;

function record(name: string, status: GateStatus, durMs: number, detail: string, tailText?: string): void {
    results.push({ name, status, durMs, detail, tail: tailText });
    if (status === 'FAIL') anyFail = true;
}

// ---- G1 类型门 ----
if (!existsSync(TSC)) fail2(`tsc 缺失：${TSC}`);
{
    const t0 = Date.now();
    const r = await run([TSC, '--noEmit']);
    const dur = Date.now() - t0;
    if (r.code === 0) {
        record('G1 tsc', 'PASS', dur, 'exit=0');
    } else {
        record('G1 tsc', 'FAIL', dur, `exit=${r.code}`, tailLines(r.out, 50));
    }
}

// ---- G2 测试门 ----
if (!anyFail || continueMode) {
    const t0 = Date.now();
    const r = await run([process.execPath, 'test']);
    const dur = Date.now() - t0;
    const failM = /\b(\d+)\s+fail\b/.exec(r.out);
    const passM = /\b(\d+)\s+pass\b/.exec(r.out);
    const totalM = /Ran\s+(\d+)\s+tests?/.exec(r.out);
    const failCount = failM?.[1] ?? '?';
    const passCount = passM?.[1] ?? '?';
    const total = totalM?.[1];
    const parsed = total !== undefined && failM !== null;
    const parseNote = parsed ? '' : '；PARSE_WARN 汇总行未解析，以退出码为准';
    const warn = parsed && Number(total) < CASE_BASELINE ? `；WARN 用例数低于基线 ${CASE_BASELINE}` : '';
    let ok = r.code === 0;
    if (parsed) ok = ok && failCount === '0' && Number(total) > 0;
    record('G2 test', ok ? 'PASS' : 'FAIL', dur, `cases=${total ?? '?'} pass=${passCount} fail=${failCount}${parseNote}${warn}`, ok ? undefined : tailLines(r.out, 50));
} else {
    record('G2 test', 'SKIPPED', 0, '前段 FAIL 短路');
}

// ---- G3 探针门（无鉴权；池门 + 健康契约）----
if (!anyFail || continueMode) {
    const t0 = Date.now();

    // P1 池门：GET /servers，全部池 READY 且池数>=3（三池现实 2026-10-11 起；参照 restart-svc.ps1 的 omg-svc 就绪门）
    let p1 = 'P1=-/NO_HTTP';
    let p1ok = false;
    const deadline = Date.now() + probeTimeoutMs;
    while (Date.now() < deadline) {
        const r1 = await curlProbe(`${probeBaseUrl}/servers`);
        if (r1.status >= 200 && r1.status < 300) {
            try {
                const j = JSON.parse(r1.body) as Record<string, unknown>;
                const sv = j['servers'];
                if (typeof sv === 'object' && sv !== null) {
                    const entries = Object.entries(sv as Record<string, unknown>);
                    const ready = entries.filter(([, v]) => typeof v === 'object' && v !== null && (v as Record<string, unknown>)['state'] === 'READY');
                    if (entries.length >= 3 && ready.length === entries.length) {
                        p1 = `P1=${r1.status}/ALL_READY(${entries.length})`;
                        p1ok = true;
                        break;
                    }
                    p1 = `P1=${r1.status}/HTTP_UP servers=${entries.length} ready=${ready.length}`;
                } else {
                    p1 = `P1=${r1.status}/PARSE_FAIL`;
                }
            } catch {
                p1 = `P1=${r1.status}/PARSE_FAIL`;
            }
        } else if (r1.status > 0) {
            p1 = `P1=${r1.status}`;
        }
        await Bun.sleep(500);
    }

    // P2 健康契约：GET /health，status=ok
    const r2 = await curlProbe(`${probeBaseUrl}/health`);
    let p2 = `P2=${r2.status}`;
    let p2ok = false;
    if (r2.status >= 200 && r2.status < 300) {
        try {
            const j = JSON.parse(r2.body) as Record<string, unknown>;
            if (j['status'] === 'ok') {
                p2 = 'P2=200/ok';
                p2ok = true;
            } else {
                p2 = 'P2=200/BAD_STATUS';
            }
        } catch {
            p2 = 'P2=200/PARSE_FAIL';
        }
    }

    record('G3 probe', p1ok && p2ok ? 'PASS' : 'FAIL', Date.now() - t0, `${p1} ${p2}`);
} else {
    record('G3 probe', 'SKIPPED', 0, '前段 FAIL 短路');
}

// ---- 报告与退出码 ----
console.log('=== OMG REGRESS REPORT ===');
for (const g of results) {
    const dur = `${(g.durMs / 1000).toFixed(1)}s`;
    console.log(`${g.name.padEnd(9)} ${g.status.padEnd(7)} ${dur.padStart(6)}  ${g.detail}`);
    if (g.tail !== undefined) console.log(g.tail);
}
const passGates = results.filter((g) => g.status === 'PASS').length;
console.log(`SUMMARY ${anyFail ? 'FAIL' : 'PASS'} (${passGates}/${results.length} gates)`);
process.exit(anyFail ? 1 : 0);
