// 全局文档改名：mcp-gateway -> open-mcp-gateway（仅纯文本替换）
const files = [
    'README.md',
    'doc/README.zh_CN.md',
    'doc/README.self.md',
    'doc/diagrams/mcp-gateway-architecture.drawio',
    'doc/diagrams/mcp-gateway 核心架构拓扑图.drawio',
    'ps1_scripts/test-gateway.ps1',
];
for (const f of files) {
    const text = await Bun.file(f).text();
    if (!text.includes('mcp-gateway')) { console.log(`skip (no match): ${f}`); continue; }
    // 防止 open-mcp-gateway 被二次改写：先断言不含 open- 前缀
    if (text.includes('open-mcp-gateway')) { console.error(`ABORT: ${f} 已含 open-mcp-gateway`); process.exit(1); }
    await Bun.write(f, text.replaceAll('mcp-gateway', 'open-mcp-gateway'));
    console.log(`done: ${f}`);
}
// drawio 文件名改名
const renames: Array<[string, string]> = [
    ['doc/diagrams/mcp-gateway-architecture.drawio', 'doc/diagrams/open-mcp-gateway-architecture.drawio'],
    ['doc/diagrams/mcp-gateway 核心架构拓扑图.drawio', 'doc/diagrams/open-mcp-gateway 核心架构拓扑图.drawio'],
];
for (const [from, to] of renames) {
    await Bun.write(to, await Bun.file(from).arrayBuffer());
    const old = Bun.file(from);
    await old.delete();
    console.log(`renamed: ${from} -> ${to}`);
}
