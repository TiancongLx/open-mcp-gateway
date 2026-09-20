export class AsyncMutex {
    private mutex = Promise.resolve();

    public lock(): Promise<() => void> {
        let begin: (unlock: () => void) => void = () => {};
        this.mutex = this.mutex.then(() => {
            return new Promise(begin);
        });
        return new Promise((res) => {
            begin = res;
        });
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
