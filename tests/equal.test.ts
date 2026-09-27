// deepEqual 单元测试（键序无关深比较，配置比对专用，语义见 src/utils/equal.ts 头注）。
import { describe, test, expect } from 'bun:test';
import { deepEqual } from '../src/utils/equal';

describe('deepEqual（键序无关深比较）', () => {
    test('原始值：Object.is 语义', () => {
        expect(deepEqual(1, 1)).toBe(true);
        expect(deepEqual('a', 'a')).toBe(true);
        expect(deepEqual(true, true)).toBe(true);
        expect(deepEqual(null, null)).toBe(true);
        expect(deepEqual(undefined, undefined)).toBe(true);
        expect(deepEqual(NaN, NaN)).toBe(true);
        expect(deepEqual(1, '1')).toBe(false);
        expect(deepEqual(null, undefined)).toBe(false);
        expect(deepEqual(0, -0)).toBe(false);
    });

    test('数组顺序敏感、长度敏感', () => {
        expect(deepEqual(['a', 'b'], ['a', 'b'])).toBe(true);
        expect(deepEqual(['a', 'b'], ['b', 'a'])).toBe(false);
        expect(deepEqual(['a'], ['a', 'b'])).toBe(false);
        expect(deepEqual([], [])).toBe(true);
    });

    test('对象键序无关、键集敏感', () => {
        expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
        expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
        expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
        expect(deepEqual({ a: undefined }, {})).toBe(false);
    });

    test('嵌套配置形态：键序反转判等、值差异判不等', () => {
        const configA = { command: 'bun', args: ['run', 'x.ts'], env: { A: '1', B: '2' }, timeout: 5000 };
        const configB = { timeout: 5000, env: { B: '2', A: '1' }, args: ['run', 'x.ts'], command: 'bun' };
        expect(deepEqual(configA, configB)).toBe(true);
        expect(deepEqual(configA, { ...configB, timeout: 6000 })).toBe(false);
        expect(deepEqual(configA, { ...configB, args: ['run', 'y.ts'] })).toBe(false);
        expect(deepEqual(configA, { ...configB, env: { A: '1', B: '3' } })).toBe(false);
    });

    test('非普通对象（Date 等）一律判不等', () => {
        expect(deepEqual(new Date(0), new Date(0))).toBe(false);
        expect(deepEqual({ d: new Date(0) }, { d: new Date(0) })).toBe(false);
    });
});
