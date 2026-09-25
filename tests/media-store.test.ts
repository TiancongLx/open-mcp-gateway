// media-store 单测：存取回环、MIME 映射、文件名安全（防路径穿越）、过期/缺失回落。
import { describe, test, expect } from 'bun:test';
import { putMedia, getMedia } from '../src/server/media-store';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_BYTES = Buffer.from(PNG, 'base64');

describe('media-store', () => {
    test('put/get 回环：字节与 MIME 保真', async () => {
        const name = await putMedia(PNG_BYTES, 'image/png');
        expect(name).toMatch(/\.png$/);
        const got = await getMedia(name);
        expect(got).not.toBeNull();
        expect(got!.mimeType).toBe('image/png');
        expect(Buffer.from(got!.bytes).equals(PNG_BYTES)).toBe(true);
    });

    test('MIME 映射：jpeg → image/jpeg', async () => {
        const name = await putMedia(PNG_BYTES, 'image/jpeg');
        expect(name).toMatch(/\.jpg$/);
        const got = await getMedia(name);
        expect(got!.mimeType).toBe('image/jpeg');
    });

    test('文件名安全：路径穿越与非法字符回落 null', async () => {
        expect(await getMedia('../evil.png')).toBeNull();
        expect(await getMedia('..\\evil.png')).toBeNull();
        expect(await getMedia('a/b.png')).toBeNull();
        expect(await getMedia('')).toBeNull();
    });

    test('缺失文件回落 null', async () => {
        expect(await getMedia('nonexistent-abc123.png')).toBeNull();
    });
});
