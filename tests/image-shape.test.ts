// OWUI 图像整形纯函数单测：覆盖 base64 解码、字段兼容（data/blob）、
// 多块/空载/错误回落、以及协商头判定（X-OMG-Compat / Accept）。
import { describe, test, expect } from 'bun:test';
import { shapeImageResult, isOwuiImageCompat } from '../src/server/image-shape';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_BYTES = Buffer.from(PNG, 'base64');

describe('shapeImageResult', () => {
    test('单图像块（data）→ 整形，按 mimeType 定扩展名', () => {
        const shaped = shapeImageResult(
            { content: [{ type: 'image', mimeType: 'image/png', data: PNG }] },
            'capture_tab'
        );
        expect(shaped).not.toBeNull();
        expect(shaped!.mimeType).toBe('image/png');
        expect(shaped!.filename).toBe('capture_tab.png');
        expect(Buffer.from(shaped!.bytes).equals(PNG_BYTES)).toBe(true);
    });

    test('blob 字段兼容（OWUI 侧命名）', () => {
        const shaped = shapeImageResult(
            { content: [{ type: 'image', mimeType: 'image/jpeg', blob: PNG }] },
            'shot'
        );
        expect(shaped).not.toBeNull();
        expect(shaped!.filename).toBe('shot.jpg');
        expect(Buffer.from(shaped!.bytes).equals(PNG_BYTES)).toBe(true);
    });

    test('并存 text 元数据块仍整形（元数据块丢弃）', () => {
        const shaped = shapeImageResult(
            {
                content: [
                    { type: 'image', mimeType: 'image/png', data: PNG },
                    { type: 'text', text: '{"tabId":1}' }
                ]
            },
            'shot'
        );
        expect(shaped).not.toBeNull();
    });

    test('缺省 mimeType 回落 image/png', () => {
        const shaped = shapeImageResult({ content: [{ type: 'image', data: PNG }] }, 'shot');
        expect(shaped!.mimeType).toBe('image/png');
    });

    test('多图像块回落 null', () => {
        expect(
            shapeImageResult(
                { content: [{ type: 'image', data: PNG }, { type: 'image', data: PNG }] },
                'shot'
            )
        ).toBeNull();
    });

    test('空 data/blob 回落 null', () => {
        expect(shapeImageResult({ content: [{ type: 'image', mimeType: 'image/png', data: '' }] }, 'shot')).toBeNull();
    });

    test('isError 结果回落 null', () => {
        expect(
            shapeImageResult({ content: [{ type: 'image', data: PNG }], isError: true }, 'shot')
        ).toBeNull();
    });

    test('非 content 数组回落 null', () => {
        expect(shapeImageResult({ content: 'data:image/png;base64,x' }, 'shot')).toBeNull();
        expect(shapeImageResult(null, 'shot')).toBeNull();
        expect(shapeImageResult({}, 'shot')).toBeNull();
    });

    test('工具名做文件名安全化', () => {
        const shaped = shapeImageResult({ content: [{ type: 'image', data: PNG }] }, 'a b/c:d');
        expect(shaped!.filename).toBe('a_b_c_d.png');
    });
});

describe('isOwuiImageCompat', () => {
    test('X-OMG-Compat: owui-image 触发（大小写不敏感）', () => {
        expect(isOwuiImageCompat(new Headers({ 'X-OMG-Compat': 'owui-image' }))).toBe(true);
        expect(isOwuiImageCompat(new Headers({ 'x-omg-compat': 'OWUI-IMAGE' }))).toBe(true);
    });

    test('Accept 显式含 image/* 触发', () => {
        expect(isOwuiImageCompat(new Headers({ Accept: 'image/png' }))).toBe(true);
        expect(isOwuiImageCompat(new Headers({ Accept: 'image/*, application/json' }))).toBe(true);
    });

    test('默认 */* 与 application/json 不触发', () => {
        expect(isOwuiImageCompat(new Headers({}))).toBe(false);
        expect(isOwuiImageCompat(new Headers({ Accept: '*/*' }))).toBe(false);
        expect(isOwuiImageCompat(new Headers({ Accept: 'application/json' }))).toBe(false);
    });
});
