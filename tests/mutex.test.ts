// P0-1 回归测试：AsyncMutex 链式门闩
// 覆盖 Greptile review finding 4 要求的全部断言维度：
// FIFO 顺序 / 临界区不重叠 / 异常后释放 / 后续等待者不被挂死 / 不可重入契约
import { describe, test, expect } from 'bun:test';
import { AsyncMutex } from '../src/utils/lock';

describe('AsyncMutex（P0-1 链式门闩回归）', () => {
    test('FIFO：并发 runExclusive 按到达顺序进入临界区', async () => {
        const mutex = new AsyncMutex();
        const order: number[] = [];
        let running = 0;
        let maxConcurrent = 0;

        await Promise.all(
            [1, 2, 3, 4, 5].map(async (id) => {
                await mutex.runExclusive(async () => {
                    running++;
                    maxConcurrent = Math.max(maxConcurrent, running);
                    order.push(id);
                    await new Promise((r) => setTimeout(r, 5));
                    running--;
                });
            })
        );

        expect(order).toEqual([1, 2, 3, 4, 5]);
        expect(maxConcurrent).toBe(1);
    });

    test('临界区互不重叠（持有期间 isLocked 为真，退出后复位）', async () => {
        const mutex = new AsyncMutex();
        let inside = false;
        let overlapDetected = false;

        await Promise.all(
            [0, 1, 2].map(async () => {
                await mutex.runExclusive(async () => {
                    if (inside) overlapDetected = true;
                    inside = true;
                    expect(mutex.isLocked).toBe(true);
                    await new Promise((r) => setTimeout(r, 2));
                    inside = false;
                });
            })
        );

        expect(overlapDetected).toBe(false);
        expect(mutex.isLocked).toBe(false);
    });

    test('回调抛异常后锁仍被释放，后续等待者不挂死', async () => {
        const mutex = new AsyncMutex();

        await expect(
            mutex.runExclusive(async () => {
                throw new Error('临界区内故障');
            })
        ).rejects.toThrow('临界区内故障');

        expect(mutex.isLocked).toBe(false);

        let ran = false;
        await mutex.runExclusive(async () => {
            ran = true;
        });
        expect(ran).toBe(true);
    });

    test('手动 lock()/release 后 isLocked 复位，FIFO 等待者获得入场', async () => {
        const mutex = new AsyncMutex();
        const releaseA = await mutex.lock();
        expect(mutex.isLocked).toBe(true);

        let bEntered = false;
        const b = mutex.runExclusive(async () => {
            bEntered = true;
        });
        expect(bEntered).toBe(false); // b 尚在排队

        releaseA();
        await b;
        expect(bEntered).toBe(true);
        expect(mutex.isLocked).toBe(false);
    });

    test('契约：不可重入 —— 嵌套 runExclusive 必然自死锁（1s 守护超时验证挂起）', async () => {
        const mutex = new AsyncMutex();
        let deadlockObserved = false;

        const outer = mutex.runExclusive(async () => {
            // 不可重入契约：此处再次获取将自死锁。用 1s 超时守护证明它确实挂起。
            const inner = mutex.runExclusive(async () => 42);
            await Promise.race([
                inner,
                new Promise((_, reject) => setTimeout(() => reject(new Error('guard-timeout')), 1000)),
            ]);
        });

        try {
            await outer;
        } catch {
            deadlockObserved = true;
        }

        expect(deadlockObserved).toBe(true);
    });
});
