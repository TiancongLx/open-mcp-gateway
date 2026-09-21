# Open MCP Gateway (OMG)

> High-performance MCP-to-OpenAPI 3.1.0 gateway, built for the Open WebUI ecosystem.

Built with **Bun 1.4** and **TypeScript**. It aggregates locally deployed MCP (Model Context Protocol) service nodes — native binary stdio, Node/Bun script streaming pipelines, or SSE/HTTP network transports — into HTTP RESTful routes strictly aligned with the **OpenAPI 3.1.0** specification, ready to be consumed as tools by external clients such as Open WebUI.

*Community project — not affiliated with the Open WebUI team.*

## Features

- **Strict OpenAPI 3.1.0 contract**: tool inputs are mounted under `requestBody.content['application/json'].schema`; generated `operationId`s match the original tool names exactly, with no `tool_*_post` naming pollution
- **Full transport coverage**: Native Binary Stdio / Script Stdio / SSE / HTTP unified under one gateway, with protocol wrapping, lifecycle self-healing, and hot reloading
- **Blue-green session pool**: service session hot-swapping guarded by an AsyncMutex, so config updates never interrupt in-flight requests
- **Cancellation-aware lifecycle**: connection handshakes accept an `AbortSignal`; graceful shutdown aborts in-flight handshakes and releases sessions instead of deadlocking against the shutdown watchdog. `AsyncMutex` is deliberately **non-reentrant** — nesting `runExclusive` calls on the same key self-deadlocks by contract (covered by regression tests)
- **Cross-platform XDG layout**: strict separation of config, data, state, and cache directories — zero pollution of the source tree
- **Single-binary distribution**: `bun build --compile` produces a native executable with no runtime dependencies
- **Reverse-proxy friendly**: `X-Forwarded-*` headers are parsed automatically, so `servers.url` in OpenAPI documents always reflects the real external base URL

## Architecture

```txt
┌──────────────────────────────┐
│      External Clients        │
│        Open WebUI            │
└──────────────┬───────────────┘
               │ HTTP / HTTPS
               ▼
┌──────────────────────────────┐
│ Reverse Proxy (Caddy/Nginx)  │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│      Open MCP Gateway        │
│  - OpenAPI 3.1.0 generation  │
│  - Blue-green session pool   │
│  - XDG paths & interpolation │
└──────┬───────────────┬───────┘
       │ JSON-RPC (stdio)
       ▼
┌──────────────────────────────┐
│      MCP service processes   │
│  (codebase-memory, etc.)     │
└──────────────────────────────┘
```

## Installation

```bash
# Run from source (requires Bun 1.4+)
bun install
bun run dev

# Or compile into a single native executable
bun run build   # Output: build/open-mcp-gateway(.exe)
```

## Configuration

The config file lives at `$XDG_CONFIG_HOME/open-mcp-gateway/config.json5` (JSON5 format, comments and trailing commas supported). Paths support environment variable interpolation — `${APP_DATA_DIR}`, `${XDG_DATA_HOME}`, `${HOME}` / `%USERPROFILE%`, and more — for cross-machine portability.

```json5
{
    mcpServers: {
        // Example 1: local native binary MCP (Native Binary Stdio)
        codebase_memory: {
            command: "${HOME}/.local/bin/codebase-memory-mcp",
            args: [],
            env: {},
        },

        // Example 2: npm-packaged MCP (Script Stdio)
        // External packages live under ${APP_DATA_DIR}; see Plugin Management below
        another_mcp: {
            command: "bun",
            args: ["run", "${APP_DATA_DIR}/node_modules/<pkg>/dist/index.js"],
            env: {},
        },
    },

    host: "127.0.0.1",
    port: 9090,
}
```

### XDG Directory Layout

| Directory | Env Variable | Purpose |
| :--- | :--- | :--- |
| Config | `XDG_CONFIG_HOME` | Main config `config.json5` |
| Data | `XDG_DATA_HOME` | External MCP plugin repository (its own `package.json`) |
| State | `XDG_STATE_HOME` | Runtime state and persistent logs |
| Cache | `XDG_CACHE_HOME` | Spec document cache and transient runtime data |

## External MCP Plugin Management

Business MCP extension packages are never installed inside this repository; they are centrally managed in the data directory:

```bash
cd "$XDG_DATA_HOME/open-mcp-gateway"
bun add <mcp-package-name>    # install
bun update <pkg>              # upgrade
```

## Integrating with Open WebUI

1. Start the gateway behind a reverse proxy (e.g., Caddy). The gateway parses `X-Forwarded-*` headers automatically to generate the correct external base URL
2. In Open WebUI's admin panel (Functions / Tools / OpenAPI), register each MCP's OpenAPI document URL:

```txt
http://<gateway-host>:8444/codebase_memory/openapi.json
```

3. Done. Open WebUI can now use all of your local MCP services as native tools.

## Testing and Logs

```bash
bun run test          # bun test: concurrency contract tests for AsyncMutex (FIFO /
                      # no-overlap / release-on-throw / non-reentrant) plus the P1
                      # shutdown regression — a fake stdio node with a 60s handshake
                      # timeout must still shut down within the 5s watchdog window

tail -f "$XDG_STATE_HOME/open-mcp-gateway/logs/gateway.log"   # log monitoring
```

## License

MIT
