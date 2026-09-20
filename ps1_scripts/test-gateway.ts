import * as c from 'yoctocolors';

const BASE_URL = 'http://127.0.0.1:9090';

console.log(c.cyan('======================================================================'));
console.log(c.cyan('>>> [mcp-gateway] 自动化断言回归套件 (Bun TypeScript)'));
console.log(c.cyan('======================================================================\n'));

async function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
    console.log(c.yellow('[1/4] 启动测试子进程...'));
    const proc = Bun.spawn(['bun', 'run', './src/index.ts'], {
        cwd: process.cwd(),
        stdout: 'inherit',
        stderr: 'inherit',
    });

    await delay(2000);

    try {
        console.log(c.yellow('\n[2/4] 测试 GET /health...'));
        const healthRes = await fetch(`${BASE_URL}/health`);
        const health = await healthRes.json();
        console.log(c.green(`  [✓] /health: ${JSON.stringify(health)}`));

        console.log(c.yellow('\n[3/4] 验证带反向代理头部的 OpenAPI 契约...'));
        const openApiRes = await fetch(`${BASE_URL}/codebase_memory/openapi.json`, {
            headers: {
                'X-Forwarded-Proto': 'https',
                'X-Forwarded-Host': 'mcp.local:8444',
            },
        });
        const spec = (await openApiRes.json()) as any;

        if (spec.openapi !== '3.1.0') {
            throw new Error(`OpenAPI 规范版本错误: ${spec.openapi}`);
        }
        if (spec.servers[0]?.url !== 'https://mcp.local:8444/codebase_memory') {
            throw new Error(`反向代理 Origin 注入异常: ${spec.servers[0]?.url}`);
        }
        console.log(c.green(`  [✓] 反向代理与 OpenAPI 规范验证完全通过`));

        console.log(c.green('\n>>> [4/4] 全部断言无误通过！'));
    } finally {
        proc.kill();
        console.log(c.gray('\n测试进程已释放'));
    }
}

await run();
