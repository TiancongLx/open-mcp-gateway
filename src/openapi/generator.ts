import type { McpSession } from '@/mcp/session';

export interface OpenApiSpec31 {
    openapi: '3.1.0';
    info: {
        title: string;
        version: string;
        description: string;
    };
    servers: Array<{
        url: string;
        description?: string;
    }>;
    paths: Record<string, Record<string, unknown>>;
}

export class OpenApiGenerator {
    public static generate(session: McpSession, publicOrigin: string): OpenApiSpec31 {
        const paths: Record<string, Record<string, unknown>> = {};

        for (const [toolName, tool] of session.tools.entries()) {
            const routePath = `/${toolName}`;

            const inputSchema = tool.inputSchema && typeof tool.inputSchema === 'object'
                ? tool.inputSchema
                : { type: 'object', properties: {} };

            paths[routePath] = {
                post: {
                    operationId: tool.name,
                    summary: tool.name,
                    description: tool.description || `Invoke tool ${tool.name} on server ${session.serverName}`,
                    requestBody: {
                        required: true,
                        description: `Input schema for ${tool.name}`,
                        content: {
                            'application/json': {
                                schema: inputSchema,
                            },
                        },
                    },
                    responses: {
                        '200': {
                            description:
                                'Tool execution result, content-negotiated with three representations. ' +
                                'Default (Accept: */*): for results carrying exactly one MCP image block, ' +
                                'the image is stored as gateway-hosted media and the response is a JSON ' +
                                'descriptor {screenshot: <media URL>, render: <markdown hint>} so the caller ' +
                                'can embed it via markdown (same hosted-URL rendering mechanism as AIHubMix); ' +
                                'otherwise a JSON CallToolResult envelope. Explicit Accept: image/* yields ' +
                                'raw image bytes (Content-Type: image/*). Explicit Accept: application/json ' +
                                'always yields the JSON CallToolResult envelope. Per-server switch: ' +
                                'owuiImageCompat=false pins the server to the envelope. Historical alias: ' +
                                'X-OMG-Compat: owui-image. Hosted media is served at GET /media/{name} ' +
                                '(TTL-bounded).',
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'object',
                                        properties: {
                                            content: {
                                                type: 'array',
                                                items: { type: 'object' },
                                            },
                                            isError: { type: 'boolean' },
                                        },
                                    },
                                },
                                'image/png': {
                                    schema: {
                                        type: 'string',
                                        contentMediaType: 'image/png',
                                        description: 'Raw image bytes of the single-image tool result.',
                                    },
                                },
                            },
                        },
                        '400': {
                            description: 'Invalid JSON request payload',
                        },
                        '503': {
                            description: 'MCP server session not ready',
                        },
                        '500': {
                            description: 'Internal tool execution exception',
                        },
                    },
                },
            };
        }

        return {
            openapi: '3.1.0',
            info: {
                title: `MCP Gateway - ${session.serverName}`,
                version: '1.0.0',
                description: `Standard OpenAPI 3.1.0 schema for MCP server [${session.serverName}].`,
            },
            servers: [
                {
                    url: `${publicOrigin}/${session.serverName}`,
                    description: `Endpoint cluster for ${session.serverName}`,
                },
            ],
            paths,
        };
    }
}
