// OWUI 兼容整形（服务级开关 + 内容协商）：MCP CallToolResult 中「恰好一个图像块」的结果
// 可整形为裸图像字节响应。背景（OWUI 源码 utils/middleware.py process_tool_result）：
// execute_tool_server 收到非 JSON 的 image/* 响应时包装为 data:image/... 字符串 → 转入
// tool_result_files → 对话流工具卡片内联渲染，模型侧仅保留摘要文本，base64 不进上下文。
//
// 两级裁决：
//   1. 服务级开关（config.json5 各 MCP 服务的 owuiImageCompat 字段）：缺省 = 开；
//      false = 关，该服务所有响应恒为 JSON 信封（功能总闸）。
//   2. 请求级协商：显式 Accept: application/json 优先取信封（程序化消费者逃生口）；
//      其余情况（含默认 */* 与历史别名 X-OMG-Compat: owui-image）按「开」的语义出图。
//
// 类型契约采用 MCP SDK 原语（CallToolResult / ImageContent），语义边界以 MCP 规范为准。
import type { CallToolResult, ImageContent } from '@modelcontextprotocol/sdk/types.js';

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

// 服务级开关裁决：仅当显式配置为 false 时关闭（缺省 = 开）。
export function isImageCompatEnabled(config: { owuiImageCompat?: boolean } | null | undefined): boolean {
    return config?.owuiImageCompat !== false;
}

// 请求级协商裁决（在服务级开关为开的前提下）：
// 显式 Accept: application/json → false（取 JSON 信封）；其余 → true。
// 历史别名 X-OMG-Compat: owui-image / Accept: image/* 在开关为开时本就生效，保留兼容语义。
export function shouldShapeImage(headers: Headers, compatEnabled: boolean): boolean {
    if (!compatEnabled) {
        return false;
    }
    const accept = headers.get('accept') ?? '';
    return !/application\/json/i.test(accept);
}

// 整形条件（全部满足才生效，否则原样回落 JSON 信封）：
//   1. 非 isError 结果；2. content 为数组；3. 恰好一个 type=image 块；
//   4. 该块携带非空 data（MCP 规范字段）或 blob（OWUI 侧命名，兼容回退）。
// 允许并存 text 等元数据块（整形时丢弃；模型侧由 OWUI 替换为摘要文本）。
export function shapeImageResult(result: unknown, toolName: string): ShapedImage | null {
    const record = result as Partial<CallToolResult> | null;
    if (!record || typeof record !== 'object' || record.isError === true) {
        return null;
    }
    const content = record.content;
    if (!Array.isArray(content)) {
        return null;
    }

    const images = content.filter((block): block is ImageContent => {
        const b = block as { type?: unknown } | null;
        return !!b && typeof b === 'object' && b.type === 'image';
    });
    if (images.length !== 1) {
        return null;
    }

    const image = images[0];
    const blob = (image as { blob?: unknown }).blob;
    const payload =
        typeof image.data === 'string' && image.data.length > 0
            ? image.data
            : typeof blob === 'string' && blob.length > 0
                ? blob
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
