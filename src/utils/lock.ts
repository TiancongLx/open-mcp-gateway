// utils/lock.ts — 异步互斥锁（不可重入，FIFO）
//
// P0-1 修复说明（2026-09 审查结论）：
// 旧实现用单个跨调用共享的闭包变量 `begin` 承载门闩 resolver，任意两次并发
// lock() 时后到者的 resolver 覆盖先到者 → 先到者的 runExclusive 永久挂死，
// 且无看门狗可恢复（只能强杀进程）。受影响调用方：McpPool.initialize /
// reconcile / shutdown（配置热重载与停机重叠即触发）。
//
// 新实现：链式门闩。每个 lock() 调用拥有独立的 released ticket，
// acquired 等待的是前任持有者的 released；链尾替换为本调用自己的 released。
// 消除了并发互斥下的解析器覆盖死锁。
//
// ⚠️ 不可重入契约（审查 finding 3 修正）：本锁【不可重入】。同一持锁者
// 在临界区内（含经由任意调用链）再次 lock()/await runExclusive() 将自死锁
// （内层等外层释放，外层等内层返回），且无超时保护。调用方必须保证临界区
// 内绝不再次获取本锁；如需重入语义，请另行实现 owner-aware 可重入锁。
export class AsyncMutex {
    private chain: Promise<unknown> = Promise.resolve();
    // 已发出且尚未释放的 lock() 计数（含等待中与持有中）
    private outstanding = 0;

    /** 是否存在未释放的持有者或排队者（测试与诊断用） */
    public get isLocked(): boolean {
        return this.outstanding > 0;
    }

    public lock(): Promise<() => void> {
        let unlock: () => void = () => {};
        // released：本调用持有期间挂起，unlock() 时 resolve —— 下一个排队者据此获得入场资格
        const released = new Promise<void>((res) => { unlock = res; });
        // acquired：等前任持有者释放，与本调用的 ticket 无关
        const acquired = this.chain.then(() => undefined);
        this.chain = released;
        this.outstanding++;
        const release = () => {
            this.outstanding--;
            unlock();
        };
        return acquired.then(() => release);
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
