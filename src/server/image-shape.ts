// OWUI 兼容整形（内容协商）：MCP CallToolResult 中「恰好一个图像块」的结果可协商为裸图像字节响应。
// 背景（OWUI 源码 utils/middleware.py process_tool_result）：execute_tool_server 收到非 JSON 的
// image/* 响应时包装为 data:image/... 字符串 → 转入 tool_result_files → 对话流工具卡片内联渲染，
// 模型侧仅保留摘要文本，避免 base64 撑爆上下文。默认（不带兼容协商头）行为不变，仍返回 JSON 信封。

export interface ShapedImage {
    bytes: Uint8Array;
    mimeType: string;
    filename: string;
}

const MIME_EXT: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg'
};

function extForMime(mimeType: string): string {
    return MIME_EXT[mimeType.toLowerCase()] ?? 'bin';
}

// 协商判定：显式 X-OMG-Compat: owui-image，或 Accept 显式声明 image/* 类型。
// 注意：aiohttp/浏览器默认的 Accept: */* 不触发（语义不明，避免误整形非图像结果）。
export function isOwuiImageCompat(headers: Headers): boolean {
    const compat = (headers.get('x-omg-compat') ?? '').trim().toLowerCase();
    if (compat === 'owui-image') {
        return true;
    }
    const accept = headers.get('accept') ?? '';
    return /image\//i.test(accept);
}

// 整形条件（全部满足才生效，否则原样回落 JSON 信封）：
//   1. 非 isError 结果；2. content 为数组；3. 恰好一个 type=image 块；
//   4. 该块携带非空 data 或 blob（MCP 规范为 data，兼容 OWUI 侧的 blob 命名）。
// 允许并存 text 等元数据块（整形时丢弃；模型侧由 OWUI 替换为摘要文本）。
export function shapeImageResult(result: unknown, toolName: string): ShapedImage | null {
    const record = result as { content?: unknown[]; isError?: boolean } | null;
    if (!record || typeof record !== 'object' || record.isError === true) {
        return null;
    }
    const content = record.content;
    if (!Array.isArray(content)) {
        return null;
    }

    const images = content.filter((block): block is { type: string; mimeType?: string; data?: string; blob?: string } => {
        const b = block as { type?: unknown } | null;
        return !!b && typeof b === 'object' && b.type === 'image';
    });
    if (images.length !== 1) {
        return null;
    }

    const image = images[0];
    const payload =
        typeof image.data === 'string' && image.data.length > 0
            ? image.data
            : typeof image.blob === 'string' && image.blob.length > 0
                ? image.blob
                : null;
    if (!payload) {
        return null;
    }

    const mimeType = typeof image.mimeType === 'string' && image.mimeType.length > 0 ? image.mimeType : 'image/png';
    const safeName = toolName.replace(/[^\w.-]+/g, '_') || 'capture';
    return {
        bytes: Buffer.from(payload, 'base64'),
        mimeType,
        filename: `${safeName}.${extForMime(mimeType)}`
    };
}
