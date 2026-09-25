"""
title: Screenshot Vision Sidecar
author: OMG contrib
version: 0.3.0
description: 为工具截图补全两项 OWUI 缺失能力——(1) 模型视觉：把工具结果中的截图（OMG media 描述符）以图像输入喂给模型（优先直取描述符 dataUri，回退按基址候选取图），支持后续轮关键词回注；(2) 确定性展示：截图落库到会话消息并推送 chat:message:files 事件（与内置 generate_image 同轨）。对消息对象任意位置出现的 {"screenshot": ...} 描述符生效（逐字符串深扫描），处理后改写为元数据标记（深替换，天然幂等）。已知要点：工具结果文本常位于 output 部件而非 content；注入须合并进既有用户消息（连续 user 消息会被规范化合并/丢弃）。
required_modules: httpx
"""

import base64
import json
import re

from pydantic import BaseModel

DESC_RE = re.compile(r'\{\s*"screenshot"\s*:\s*"(?P<url>https?://[^"]+)"[^}]*\}', re.S)
MARK_RE = re.compile(r'（截图 URL: (?P<url>https?://[^）]+)）')
INJECT_PREFIX = '【系统附图】'


class Filter:
    class Valves(BaseModel):
        vision_inject: bool = True
        display_attach: bool = True
        history_inject: bool = True
        history_keywords: str = (
            '截图,图片,图像,照片,视觉,看,读,分析,描述,识别,内容,'
            'image,picture,photo,visual,read,analyz,describ,recogniz,content'
        )
        fetch_timeout_seconds: int = 10
        fetch_base_candidates: str = 'http://100.81.173.80:9090,http://172.17.0.1:9090,http://host.docker.internal:9090'
        debug_sentinel: bool = False

    def __init__(self):
        self.valves = self.Valves()

    def _keywords(self):
        return [k.strip().lower() for k in self.valves.history_keywords.split(',') if k.strip()]

    @staticmethod
    def _iter_strings(obj):
        if isinstance(obj, str):
            yield obj
        elif isinstance(obj, dict):
            for v in obj.values():
                yield from Filter._iter_strings(v)
        elif isinstance(obj, list):
            for v in obj:
                yield from Filter._iter_strings(v)

    @staticmethod
    def _msg_blob(msg):
        return json.dumps(msg, ensure_ascii=False) if isinstance(msg, dict) else ''

    @staticmethod
    def _deep_replace(obj, raw, note):
        if isinstance(obj, dict):
            for k, v in obj.items():
                if isinstance(v, str) and raw in v:
                    obj[k] = v.replace(raw, note)
                else:
                    Filter._deep_replace(v, raw, note)
        elif isinstance(obj, list):
            for item in obj:
                Filter._deep_replace(item, raw, note)

    async def _fetch_data_uri(self, url):
        import httpx
        from urllib.parse import urlsplit
        bases = [''] + [b.strip().rstrip('/') for b in self.valves.fetch_base_candidates.split(',') if b.strip()]
        async with httpx.AsyncClient(timeout=self.valves.fetch_timeout_seconds) as client:
            for base in bases:
                target = url if not base else base + urlsplit(url).path
                try:
                    r = await client.get(target)
                    if r.status_code == 200:
                        ctype = (r.headers.get('content-type') or 'image/png').split(';')[0]
                        return f"data:{ctype};base64,{base64.b64encode(r.content).decode()}"
                except Exception:
                    continue
        return None

    async def _attach_display(self, url, __event_emitter__, __chat_id__, __message_id__):
        ok = False
        name = url.rsplit('/', 1)[-1] or 'screenshot.png'
        files = [{'type': 'image', 'url': url, 'id': name, 'name': name}]
        try:
            from open_webui.utils.chat_id import is_saved_chat_id
            if is_saved_chat_id(__chat_id__) and __message_id__:
                from open_webui.models.chats import Chats
                db_files = Chats.add_message_files_by_id_and_message_id(__chat_id__, __message_id__, files)
                ok = db_files is not None
        except Exception:
            pass
        try:
            if __event_emitter__:
                await __event_emitter__({'type': 'chat:message:files', 'data': {'files': files}})
                ok = True
        except Exception:
            pass
        return ok

    async def _process(self, body, __user__=None, __request__=None, __event_emitter__=None,
                       __chat_id__=None, __message_id__=None):
        if not isinstance(body, dict):
            return body
        messages = body.get('messages')
        if not isinstance(messages, list):
            return body

        dbg = [0, 0]
        vision_urls = []
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            hit = None
            for s in self._iter_strings(msg):
                hit = DESC_RE.search(s)
                if hit:
                    break
            if not hit:
                continue
            url, raw = hit.group('url'), hit.group(0)
            dbg[0] += 1

            display_ok = False
            if self.valves.display_attach:
                display_ok = await self._attach_display(url, __event_emitter__, __chat_id__, __message_id__)

            data_uri = None
            if self.valves.vision_inject:
                try:
                    data_uri = json.loads(raw).get('dataUri') or None
                except Exception:
                    data_uri = None
                if not data_uri:
                    data_uri = await self._fetch_data_uri(url)
                if data_uri:
                    dbg[1] += 1
                    vision_urls.append(data_uri)

            if data_uri or display_ok:
                if display_ok:
                    note = f'（截图元数据：已向用户展示，且已随本轮消息提供视读；截图 URL: {url}）'
                else:
                    note = f'（截图元数据：已随本轮消息提供视读；截图 URL: {url}。如需向用户展示，可嵌入一次 Markdown 图片 ![截图]({url})）'
                self._deep_replace(msg, raw, note)

        blobs = [self._msg_blob(m) for m in messages]
        already = any(INJECT_PREFIX in b for b in blobs)
        if self.valves.vision_inject and vision_urls and not already:
            # 就地合并进最后一条用户消息：连续同角色消息会被规范化合并/丢弃
            target = None
            for m in reversed(messages):
                if isinstance(m, dict) and m.get('role') == 'user':
                    target = m
                    break
            parts = [{'type': 'image_url', 'image_url': {'url': u}} for u in vision_urls]
            hint = {'type': 'text', 'text': f'{INJECT_PREFIX}系统已附加上方工具结果中的截图，请直接视读并据此分析。'}
            if target is not None:
                old = target.get('content')
                if isinstance(old, str):
                    target['content'] = [hint, {'type': 'text', 'text': old}] + parts
                elif isinstance(old, list):
                    target['content'] = [hint] + parts + old
                else:
                    target['content'] = [hint] + parts
            else:
                messages.append({'role': 'user', 'content': [hint] + parts})

        if self.valves.history_inject and not vision_urls and not already:
            last_user = next((m for m in reversed(messages) if isinstance(m, dict) and m.get('role') == 'user'), None)
            q = self._msg_blob(last_user or {}).lower()
            if q and any(k in q for k in self._keywords()):
                hist = None
                for m in reversed(messages):
                    for s in self._iter_strings(m):
                        hit = MARK_RE.search(s)
                        if hit:
                            hist = hit.group('url')
                            break
                    if hist:
                        break
                if hist:
                    data_uri = await self._fetch_data_uri(hist)
                    if data_uri:
                        target = last_user
                        parts = [{'type': 'image_url', 'image_url': {'url': data_uri}}]
                        hint = {'type': 'text', 'text': f'{INJECT_PREFIX}这是此前会话中的截图（系统自动附加），请据此回答用户。'}
                        old = target.get('content')
                        if isinstance(old, str):
                            target['content'] = [hint, {'type': 'text', 'text': old}] + parts
                        elif isinstance(old, list):
                            target['content'] = [hint] + parts + old

        if self.valves.debug_sentinel:
            messages.append({'role': 'user', 'content': f'【哨兵】desc={dbg[0]} fetch={dbg[1]} inject={len(vision_urls)}'})
        return body

    async def inlet(self, body, __user__=None, __request__=None, __event_emitter__=None,
                    __chat_id__=None, __message_id__=None):
        return await self._process(body, __user__, __request__, __event_emitter__, __chat_id__, __message_id__)

    async def request(self, body, __user__=None, __request__=None, __event_emitter__=None,
                      __chat_id__=None, __message_id__=None):
        return await self._process(body, __user__, __request__, __event_emitter__, __chat_id__, __message_id__)
