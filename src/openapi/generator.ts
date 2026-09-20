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
                            description: 'Tool execution result',
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
