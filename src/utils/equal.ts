// 键序无关的深比较（配置比对专用）。
// 背景：pool.reconcile 曾以 JSON.stringify 序列化比对配置，对象键序不同即判为
// 变更，触发冗余平滑重载并伴随 ERROR 级别日志（ADR KNOWN_BUGS 首条）。
// 语义约定（作用域为 JSON5 解析产物：原始值 / 数组 / 普通对象）：
//   - 原始值：Object.is（NaN 判等，+0 与 -0 判不等）；
//   - 数组：长度相等且逐元素按本规则比较（顺序敏感，args 顺序即命令行语义）；
//   - 普通对象：键集合相同（与键序无关）且同键值按本规则比较；
//   - 其余类型（Date、Map、类实例等）一律判不等。

export function deepEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;

    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b)) return false;
        if (a.length !== b.length) return false;
        return a.every((item, index) => deepEqual(item, b[index]));
    }

    if (!isPlainObject(a) || !isPlainObject(b)) return false;

    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
        (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key])
    );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
        && Object.getPrototypeOf(value) === Object.prototype;
}
