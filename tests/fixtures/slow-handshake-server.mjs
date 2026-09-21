// 假 MCP stdio 节点：吞掉 stdin、不产生任何输出。
// 客户端 initialize 请求永远不会被回应 → 握手挂起直至超时或被 abort。
// 供 tests/pool.shutdown.test.ts 的 P1 回归测试使用。
process.stdin.resume();
setInterval(() => {}, 1 << 30); // 保持事件循环活跃
process.on('SIGTERM', () => process.exit(0));
