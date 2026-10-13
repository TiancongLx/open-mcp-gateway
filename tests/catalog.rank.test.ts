// 统一工具目录内核单测（决策 24）：分词（camelCase 拆分 + CJK 二元组）与加权重叠排名语义。
import { describe, test, expect } from 'bun:test';
import { tokenize, searchCatalog, buildManifestText, clampCount, type CatalogToolEntry } from '../src/openapi/catalog';

const makeEntry = (server: string, name: string, description: string, properties: string[] = []): CatalogToolEntry => ({
    server,
    name,
    description,
    inputSchema: {
        type: 'object',
        properties: Object.fromEntries(properties.map((p) => [p, { type: 'string' }])),
    },
});

describe('catalog 分词', () => {
    test('camelCase 与分隔符拆分', () => {
        expect(tokenize('readFile')).toEqual(['read', 'file']);
        expect(tokenize('read_doc')).toEqual(['read', 'doc']);
        expect(tokenize('HTMLParser')).toEqual(['html', 'parser']);
    });

    test('CJK 二元组（含单字）', () => {
        expect(tokenize('读取文档')).toEqual(['读取', '取文', '文档']);
        expect(tokenize('文档')).toEqual(['文档']);
        expect(tokenize('单')).toEqual(['单']);
    });

    test('中英混排与空值', () => {
        expect(tokenize('read 文档 now')).toEqual(['read', '文档', 'now']);
        expect(tokenize('')).toEqual([]);
        expect(tokenize(null)).toEqual([]);
    });
});

describe('catalog 排名', () => {
    const entries = [
        makeEntry('s1', 'alpha', 'unrelated text', ['chart']),
        makeEntry('s1', 'chart_reader', 'unrelated text'),
        makeEntry('s1', 'chart_writer', 'unrelated text'),
        makeEntry('s2', 'gamma', 'chart utility'),
    ];

    test('加权重叠：name×3 > 参数名×2 > description×1；并列按名称排序', () => {
        const hits = searchCatalog(entries, 'chart');
        expect(hits.map((h) => h.name)).toEqual(['chart_reader', 'chart_writer', 'alpha', 'gamma']);
    });

    test('精确名直返（跨池同名全量返回以消歧）', () => {
        const dupes = [
            makeEntry('a', 'report', 'x'),
            makeEntry('b', 'report', 'y'),
            makeEntry('c', 'report_maker', 'z'),
        ];
        const hits = searchCatalog(dupes, 'report');
        expect(hits.map((h) => `${h.server}:${h.name}`)).toEqual(['a:report', 'b:report']);
    });

    test('CJK 查询命中描述', () => {
        const cjk = [makeEntry('s1', 'read_doc', '读取文档内容')];
        expect(searchCatalog(cjk, '文档').map((h) => h.name)).toEqual(['read_doc']);
    });

    test('无命中与空查询', () => {
        expect(searchCatalog(entries, 'zzz')).toEqual([]);
        expect(searchCatalog(entries, '   ')).toEqual([]);
    });

    test('count 缺省与钳制', () => {
        expect(clampCount(undefined)).toBe(5);
        expect(clampCount(0)).toBe(1);
        expect(clampCount(999)).toBe(20);
        expect(clampCount(3.9)).toBe(3);
        const many = Array.from({ length: 30 }, (_, i) => makeEntry('s', `tool_${i}`, 'common token'));
        expect(searchCatalog(many, 'common', 2)).toHaveLength(2);
    });

    test('命中项形状 {server,name,description,input_schema}', () => {
        const [hit] = searchCatalog([makeEntry('s1', 'alpha', 'd', ['p'])], 'alpha');
        expect(Object.keys(hit).sort()).toEqual(['description', 'input_schema', 'name', 'server']);
    });
});

describe('catalog 清单（manifest）', () => {
    test('预算内完整输出；超预算截断并标记', () => {
        const view = {
            ready: [
                { server: 'aa', tools: [makeEntry('aa', 'one', ''), makeEntry('aa', 'two', '')] },
                { server: 'bb', tools: [makeEntry('bb', 'three', '')] },
            ],
            unavailable: [],
        };
        const full = buildManifestText(view, 200);
        expect(full.truncated).toBe(false);
        expect(full.text).toBe('- aa: one, two\n- bb: three');

        const tight = buildManifestText(view, 16);
        expect(tight.truncated).toBe(true);
        expect(tight.text.startsWith('- aa: one')).toBe(true);
    });

    test('空视图输出空清单', () => {
        const empty = buildManifestText({ ready: [], unavailable: [] });
        expect(empty.text).toBe('');
        expect(empty.truncated).toBe(false);
    });
});
