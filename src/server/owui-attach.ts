// 方案 B：网关直写 OWUI 消息附件（attach 副作用）。
// 目标：工具图像在 OWUI 对话流「用户可见 + 模型同轮可视」。双写语义：
//   1. 工具响应本身整形为裸 data: URI 字符串 → OWUI process_tool_result /
//      extract_base64_images 分流为 input_image（middleware.py，仅喂模型，同轮视读）；
//   2. 本模块的副作用把同一图像挂入 message.files（用户可见；下一轮还会随
//      message.files 回注 image_url，四通道矩阵中用户 ✓ / 模型 ✓ 的唯一通道）。
//
// 副作用两步：
//   a. POST {base}/api/v1/files/?process=false 上传字节（process=false 跳过 RAG
//      管线，同内置 upload_image）→ 得文件 id；
//   b. POST {base}/api/v1/chats/{chatId}/messages/{messageId}/event（type=files）：
//      该事件经 get_event_emitter(update_db=True) 双效果——upsert 将 files 挂入
//      message.files（merge 语义，不覆写 content），并经 sio 实时推送前端
//      （Chat.svelte 原生渲染 message.files；机制同内置 generate_image）。
//      注意：POST .../messages/{message_id} 的 MessageForm 仅收 content，
//      挂 files 必须走 event 端点（models/chats.py 的消息模型含 files 字段）。
//   附件 URL 恒为 OWUI 自身的相对路径 /api/v1/files/{id}/content（与其
//   upload_image 的 url_path_for 同构）：各端按自己的源解析，手机可达；
//   严禁回填网关内网地址（侧车方案即败于此）。
//
// chat_id / message_id 由 OWUI 随工具请求注入头携带（env.py
// FORWARD_SESSION_INFO_HEADER_CHAT_ID / MESSAGE_ID 缺省值，utils/tools.py:179-182）。
// 全部副作用尽力而为：失败仅告警并返回 null，绝不影响工具响应本身。
import { warn } from '@/utils/logger';
import type { OwuiAttachConfig } from '@/config/types';
import type { ShapedImage } from './image-shape';

export type { OwuiAttachConfig };

export interface AttachTarget {
    chatId: string;
    messageId: string;
}

const CHAT_ID_HEADER = 'x-openwebui-chat-id';
const MESSAGE_ID_HEADER = 'x-openwebui-message-id';
const REQUEST_TIMEOUT_MS = 15000;

export function resolveAttachTarget(headers: Headers): AttachTarget | null {
    const chatId = headers.get(CHAT_ID_HEADER)?.trim();
    const messageId = headers.get(MESSAGE_ID_HEADER)?.trim();
    if (!chatId || !messageId) {
        return null;
    }
    return { chatId, messageId };
}

export async function attachImageToOwuiMessage(
    cfg: OwuiAttachConfig,
    target: AttachTarget,
    shaped: ShapedImage
): Promise<string | null> {
    const base = cfg.base.replace(/\/+$/, '');
    try {
        const form = new FormData();
        form.append('file', new Blob([shaped.bytes], { type: shaped.mimeType }), shaped.filename);
        const uploadRes = await fetch(`${base}/api/v1/files/?process=false`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.token}` },
            body: form,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!uploadRes.ok) {
            warn(`[OWUI 直写] 文件上传失败: HTTP ${uploadRes.status}`);
            return null;
        }
        const uploaded = (await uploadRes.json()) as { id?: unknown };
        if (typeof uploaded.id !== 'string' || uploaded.id.length === 0) {
            warn('[OWUI 直写] 文件上传响应缺少 id');
            return null;
        }

        const url = `/api/v1/files/${uploaded.id}/content`;
        const eventRes = await fetch(
            `${base}/api/v1/chats/${encodeURIComponent(target.chatId)}/messages/${encodeURIComponent(target.messageId)}/event`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${cfg.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    type: 'files',
                    data: {
                        files: [
                            {
                                type: 'image',
                                id: uploaded.id,
                                url,
                                name: shaped.filename,
                                content_type: shaped.mimeType,
                            },
                        ],
                    },
                }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            }
        );
        if (!eventRes.ok) {
            warn(`[OWUI 直写] 消息附件挂载失败: HTTP ${eventRes.status}`);
            return null;
        }
        return url;
    } catch (err) {
        warn(`[OWUI 直写] 副作用异常: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
