// S1 · Streamable HTTP 传输与远程断连自愈——真实 HTTP 夹具集成测试。
// 覆盖：三态传输分支（streamable-http）/ 头部透传（401 负例）/ 意外断连检测与退避重连 /
// 初始连接失败不判死刑 / reconnect:false 关闭监督保持旧语义。
import { describe, test, expect, onTestFinished } from 'bun:test';
import { join, resolve } from 'node:path';
import { McpPool } from '../src/mcp/pool';

const ROOT = resolve(import.meta.dir, '..');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'streamable-server.ts');
const PORT = 19111;
const CONTROL_PORT = 19112;
const BASE = `http://127.0.0.1:${PORT}/mcp`;
const CTL = `http://127.0.0.1:${CONTROL_PORT}`;

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000, intervalMs = 50): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            if (await cond()) return true;
        } catch {
            // 轮询期间异常按未达条件处理
        }
        if (Date.now() >= deadline) return false;
        await Bun.sleep(intervalMs);
    }
}

async function waitForHttp(url: string, timeoutMs = 8000): Promise<boolean> {
    return waitFor(async () => {
        const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
        return r.status === 200;
    }, timeoutMs);
}

let proc: ReturnType<typeof Bun.spawn> | null = null;

async function startFixture(): Promise<void> {
    proc = Bun.spawn([process.execPath, FIXTURE], {
        env: {
            ...process.env,
            FIXTURE_PORT: String(PORT),
            FIXTURE_CONTROL_PORT: String(CONTROL_PORT),
            FIXTURE_REQUIRE_AUTH: '1',
        },
        stdout: 'ignore',
        stderr: 'ignore',
    });
    const up = await waitForHttp(`${CTL}/health`);
    if (!up) throw new Error('streamable fixture 未能启动');
}

async function stopFixture(): Promise<void> {
    if (!proc) return;
    try {
        proc.kill();
    } catch {
        // 进程可能已退出
    }
    await proc.exited;
    proc = null;
}

async function outage(mode: 'start' | 'stop'): Promise<void> {
    const r = await fetch(`${CTL}/outage?mode=${mode}`, { method: 'POST' });
    if (r.status !== 200) throw new Error(`outage ${mode} failed: ${r.status}`);
    await r.json();
}

const conn = (over: Record<string, unknown> = {}) => ({
    transport: 'streamable-http',
    url: BASE,
    headers: { Authorization: 'Bearer fixture-token' },
    timeout: 5000,
    callTimeoutMs: 5000,
    reconnectMinDelayMs: 200,
    reconnectMaxDelayMs: 1000,
    ...over,
});

describe('S1 · Streamable HTTP 传输与远程断连自愈', () => {
    test('连接 / 工具注册 / 调用 / 头部透传', async () => {
        await startFixture();
        const pool = new McpPool();
        onTestFinished(async () => {
            await pool.shutdown();
            await stopFixture();
        });

        await pool.addServer('remote', conn() as any);
        const session = pool.getSession('remote');
        expect(session?.state).toBe('READY');
        expect([...session!.tools.keys()].sort()).toEqual(['http_echo', 'http_ping']);

        const res = (await session!.callTool('http_echo', { anything: 'x' })) as any;
        expect(res.content[0].text).toBe(JSON.stringify({ anything: 'x' }));
    }, 30000);

    test('断连自愈：故障检测 → 退避重连 → 自动恢复', async () => {
        await startFixture();
        const pool = new McpPool();
        onTestFinished(async () => {
            await pool.shutdown();
            await stopFixture();
        });

        await pool.addServer('remote', conn() as any);
        const session = pool.getSession('remote')!;
        expect(session.state).toBe('READY');

        await outage('start');
        await expect(session.callTool('http_ping')).rejects.toBeDefined();
        expect(await waitFor(() => session.state === 'FAILED' || session.state === 'CONNECTING', 3000)).toBe(true);

        await outage('stop');
        expect(await waitFor(() => session.state === 'READY', 10000)).toBe(true);
        const res = (await session.callTool('http_ping')) as any;
        expect(res.content[0].text).toBe('pong');
    }, 30000);

    test('初始连接失败不判死刑：监督等待服务出现后自愈', async () => {
        // 注意：本用例不预启动夹具（端口无监听），验证初始失败进入监督并等待恢复
        const pool = new McpPool();
        onTestFinished(async () => {
            await pool.shutdown();
            await stopFixture();
        });

        await pool.addServer('late', conn({ timeout: 2000, reconnectMinDelayMs: 200, reconnectMaxDelayMs: 500 }) as any);
        const session = pool.getSession('late')!;
        expect(['FAILED', 'CONNECTING']).toContain(session.state);

        await startFixture();
        expect(await waitFor(() => session.state === 'READY', 10000)).toBe(true);
        const res = (await session.callTool('http_ping')) as any;
        expect(res.content[0].text).toBe('pong');
    }, 30000);

    test('reconnect:false 关闭监督：保持既有一性连接语义', async () => {
        await startFixture();
        const pool = new McpPool();
        onTestFinished(async () => {
            await pool.shutdown();
            await stopFixture();
        });

        await pool.addServer('plain', conn({ reconnect: false }) as any);
        const session = pool.getSession('plain')!;
        expect(session.state).toBe('READY');

        await outage('start');
        await expect(session.callTool('http_ping')).rejects.toBeDefined();
        expect(session.state).toBe('READY'); // 无监督：不探测、不标记、不重连

        await outage('stop');
        const res = (await session.callTool('http_ping')) as any;
        expect(res.content[0].text).toBe('pong');
    }, 30000);

    test('头部透传契约：错误凭据以 401 拒绝并落 FAILED', async () => {
        await startFixture();
        const pool = new McpPool();
        onTestFinished(async () => {
            await pool.shutdown();
            await stopFixture();
        });

        await pool.addServer('bad-auth', conn({ headers: { Authorization: 'Bearer wrong' }, reconnect: false }) as any);
        const session = pool.getSession('bad-auth')!;
        expect(session.state).toBe('FAILED');
        expect((session.lastError ?? '').match(/401|[Uu]nauthorized/)).not.toBeNull();
    }, 30000);
});
