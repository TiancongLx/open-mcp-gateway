// utils/lock.ts — 可重入安全的异步互斥锁
//
// P0-1 修复说明（2026-09 审查结论）：
// 旧实现用单个跨调用共享的闭包变量 `begin` 承载门闩 resolver，任意两次并发
// lock() 时后到者的 resolver 覆盖先到者 → 先到者的 runExclusive 永久挂死，
// 且无看门狗可恢复（只能强杀进程）。受影响调用方：McpPool.initialize /
// reconcile / shutdown（配置热重载与停机重叠即触发）。
//
// 新实现：链式门闩。每个 lock() 调用拥有独立的 released ticket，
// acquired 等待的是前任持有者的 released；链尾替换为本调用自己的 released。
// 无共享可变闭包，无死锁路径。
export class AsyncMutex {
    private chain: Promise<unknown> = Promise.resolve();

    public lock(): Promise<() => void> {
        let unlock: () => void = () => {};
        // released：本调用持有期间挂起，unlock() 时 resolve —— 下一个排队者据此获得入场资格
        const released = new Promise<void>((res) => { unlock = res; });
        // acquired：等前任持有者释放，与本调用的 ticket 无关
        const acquired = this.chain.then(() => undefined);
        this.chain = released;
        return acquired.then(() => unlock);
    }

    public async runExclusive<T>(callback: () => Promise<T> | T): Promise<T> {
        const unlock = await this.lock();
        try {
            return await callback();
        } finally {
            unlock();
        }
    }
}