// P1 回归测试：停机不再被长握手阻塞
//
// 修复前行为：initialize() 持有 pool mutex 期间握手挂起最长 timeout(本测试 60s)，
// shutdown() 的 runExclusive 排队等待同一把锁 → 5s 停机看门狗必然先 process.exit(1)。
// 修复后行为：shutdown() 先 abort 全部进行中的 connect，握手立刻以失败落定，
// 再串行释放会话 —— 全程必须 < 5000ms（看门狗窗口）。
//
// 安全性：本测试运行在独立 bun 进程中，子进程为 fixtures/slow-handshake-server.mjs
// 假节点（不回应 initialize 请求），不触碰本机正在运行的网关实例。
import { describe, test, expect, onTestFinished } from 'bun:test';
import { resolve } from 'node:path';
import { McpPool } from '../src/mcp/pool';

const FIXTURE = resolve(import.meta.dir, 'fixtures', 'slow-handshake-server.mjs');

type TransportLike = { _process?: { pid?: number }; process?: { pid?: number } } | null;

function stdioPidOf(session: unknown): number | undefined {
    const t = (session as { transport?: TransportLike })?.transport;
    return t?._process?.pid ?? t?.process?.pid;
}

describe('P1 回归：停机不再被长握手阻塞', () => {
    test('60s 握手配置下 shutdown() 必须在 5s 看门狗窗口内完成', async () => {
        const pool = new McpPool();
        const slowConfig = {
            mcpServers: {
                'slow-node-a': { command: process.execPath, args: [FIXTURE], timeout: 60000 },
                'slow-node-b': { command: process.execPath, args: [FIXTURE], timeout: 60000 },
            },
        };

        const initPromise = pool.initialize(slowConfig);
        let initSettled = false;
        void initPromise.finally(() => {
            initSettled = true;
        });

        // 等待两个握手真正进入挂起状态（假节点子进程已拉起）
        let spins = 0;
        while (!pool.hasInFlightConnections && spins < 200) {
            await new Promise((r) => setTimeout(r, 25));
            spins++;
        }
        expect(pool.hasInFlightConnections).toBe(true);

        // 登记 stdio 子进程，测试结束时强制清场（即使断言失败也不留孤儿进程）
        for (const name of ['slow-node-a', 'slow-node-b']) {
            const pid = stdioPidOf(pool.getSession(name));
            if (pid) {
                onTestFinished(() => {
                    try {
                        Bun.spawnSync(['taskkill', '/F', '/T', '/PID', String(pid)]);
                    } catch {
                        // 进程可能已随 abort 路径退出
                    }
                });
            }
        }

        // 核心断言：shutdown 全程 < 5000ms（对齐 src/index.ts 的看门狗窗口）
        const started = performance.now();
        await pool.shutdown();
        const elapsed = performance.now() - started;

        expect(elapsed).toBeLessThan(5000);
        expect(pool.hasInFlightConnections).toBe(false);
        expect(initSettled).toBe(true);

        await initPromise;
    }, 20000);
});
