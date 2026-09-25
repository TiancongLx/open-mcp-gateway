// 媒体暂存（对话流截图托管）：磁盘文件 + TTL，向对话流提供可被 <img> 直接加载的稳定 URL。
// 与 OWUI get_file_url_from_base64 同构：把二进制图像换成托管 URL，绕开其「data: 图像仅喂模型」
// 的分流（middleware.py 流式路径），使截图既可被模型引用（markdown），也可被用户直接看到。
// 治理：文件名安全白名单（防路径穿越）、TTL 惰性清理（默认 24h，OMG_MEDIA_TTL_HOURS 可调）。
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, stat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const BASE_DIR = join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'omg-media');
const TTL_MS = Number(Bun.env.OMG_MEDIA_TTL_HOURS ?? 24) * 3_600_000;
const SAFE_NAME = /^[\w.-]+$/;

const MIME_BY_EXT: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml'
};

const EXT_BY_MIME: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg'
};

function extForMime(mimeType: string): string {
    return EXT_BY_MIME[mimeType.toLowerCase()] ?? 'bin';
}

async function sweep(): Promise<void> {
    try {
        const entries = await readdir(BASE_DIR);
        const now = Date.now();
        for (const name of entries) {
            const p = join(BASE_DIR, name);
            try {
                const st = await stat(p);
                if (now - st.mtimeMs > TTL_MS) {
                    await unlink(p);
                }
            } catch {
                // 并发清理导致的 stat/unlink 失败可忽略
            }
        }
    } catch {
        // 目录不存在时忽略
    }
}

export async function putMedia(bytes: Uint8Array, mimeType: string): Promise<string> {
    await mkdir(BASE_DIR, { recursive: true });
    await sweep();
    const ext = extForMime(mimeType);
    const name = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.${ext}`;
    await writeFile(join(BASE_DIR, name), bytes);
    return name;
}

export async function getMedia(name: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    if (!SAFE_NAME.test(name)) {
        return null;
    }
    const p = join(BASE_DIR, name);
    try {
        const st = await stat(p);
        if (Date.now() - st.mtimeMs > TTL_MS) {
            await unlink(p);
            return null;
        }
        const bytes = await readFile(p);
        const ext = (name.split('.').pop() ?? '').toLowerCase();
        return { bytes, mimeType: MIME_BY_EXT[ext] ?? 'application/octet-stream' };
    } catch {
        return null;
    }
}
