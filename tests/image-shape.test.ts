// OWUI 图像整形纯函数单测：覆盖 base64 解码、字段兼容（data/blob）、多块/空载/错误回落、
// 以及两级裁决（服务级开关 isImageCompatEnabled / 请求级协商 shouldShapeImage）。
import { describe, test, expect } from 'bun:test';
import { shapeImageResult, isImageCompatEnabled, shouldShapeImage } from '../src/server/image-shape';

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

describe('isImageCompatEnabled（服务级开关：缺省开，显式 false 才关）', () => {
    test('缺省与显式 true 均为开', () => {
        expect(isImageCompatEnabled(undefined)).toBe(true);
        expect(isImageCompatEnabled({})).toBe(true);
        expect(isImageCompatEnabled({ owuiImageCompat: true })).toBe(true);
    });

    test('显式 false 为关', () => {
        expect(isImageCompatEnabled({ owuiImageCompat: false })).toBe(false);
    });
});

describe('shouldShapeImage（请求级协商）', () => {
    test('开关开：默认出图（含 */* 与历史别名头）', () => {
        expect(shouldShapeImage(new Headers({}), true)).toBe(true);
        expect(shouldShapeImage(new Headers({ Accept: '*/*' }), true)).toBe(true);
        expect(shouldShapeImage(new Headers({ Accept: 'image/png' }), true)).toBe(true);
        expect(shouldShapeImage(new Headers({ 'X-OMG-Compat': 'owui-image' }), true)).toBe(true);
    });

    test('开关开：显式 Accept: application/json 优先取信封', () => {
        expect(shouldShapeImage(new Headers({ Accept: 'application/json' }), true)).toBe(false);
        expect(shouldShapeImage(new Headers({ Accept: 'application/json, image/png' }), true)).toBe(false);
    });

    test('开关关：恒为信封', () => {
        expect(shouldShapeImage(new Headers({}), false)).toBe(false);
        expect(shouldShapeImage(new Headers({ Accept: 'image/png' }), false)).toBe(false);
    });
});
