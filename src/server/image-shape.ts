// OWUI 兼容整形（服务级开关 + 三态内容协商）：MCP CallToolResult 中「恰好一个图像块」的结果
// 可改写为三种表示之一。背景（OWUI 源码 utils/middleware.py process_tool_result）：
// execute_tool_server 收到非 JSON 的 image/* 响应时包装为 data:image/... 字符串，但流式路径
// 将「data: 前缀的图像文件」显式分流为仅供模型的 input_image（不过前端展示）；能到达前端的
// 图像文件必须携带托管 URL（如 MCP 分支经 get_file_url_from_base64 转存所得）。
//
// 三态表示（resolveImageMode）：
//   1. envelope —— CallToolResult JSON 信封（服务级开关关，或显式 Accept: application/json）
//   2. raw      —— 裸图像字节（Accept 显式含 image/*；直接二进制消费者）
//   3. attach   —— 裸 data: URI 字符串（缺省 */*；方案 B 默认态）：OWUI 把
//                  data: 图像工具结果分流为 input_image（同轮喂模型），网关同步
//                  副作用挂 message.files 补用户展示（见 owui-attach.ts）。
//
// 类型契约采用 MCP SDK 原语（CallToolResult / ImageContent）；blob 为 OWUI 侧命名兼容回退。
import type { CallToolResult, ImageContent } from '@modelcontextprotocol/sdk/types.js';

export type ImageMode = 'envelope' | 'raw' | 'attach';

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

// 请求级协商（服务级开关为开时）：
//   显式 Accept: application/json → envelope；显式 Accept: image/* → raw；其余（含 */*）→ attach。
// 历史别名 X-OMG-Compat: owui-image 保留（等价于 attach，兼容既有配置）。
export function resolveImageMode(headers: Headers, compatEnabled: boolean): ImageMode {
    if (!compatEnabled) {
        return 'envelope';
    }
    const accept = headers.get('accept') ?? '';
    if (/application\/json/i.test(accept)) {
        return 'envelope';
    }
    if (/image\//i.test(accept)) {
        return 'raw';
    }
    return 'attach';
}

// 整形条件（全部满足才生效，否则原样回落 JSON 信封）：
//   1. 非 isError 结果；2. content 为数组；3. 恰好一个 type=image 块；
//   4. 该块携带非空 data（MCP 规范字段）或 blob（OWUI 侧命名，兼容回退）。
// 允许并存 text 等元数据块（整形时丢弃）。
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
