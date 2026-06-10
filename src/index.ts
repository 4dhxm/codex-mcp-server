import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { tools } from './tools.js';

// Setup MCP server instance
const server = new Server(
  {
    name: 'codex-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register list tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools.map((tool) => {
      const zodSchema = zodToJsonSchema(tool.schema) as any;
      const { $schema, ...inputSchema } = zodSchema;
      return {
        name: tool.name,
        description: tool.description,
        inputSchema,
      };
    }),
  };
});

// Register call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }

  try {
    // Validate arguments using Zod
    const validatedArgs = tool.schema.parse(args || {});
    return await tool.handler(validatedArgs);
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `Error calling tool ${name}: ${error.message || error}`,
        },
      ],
      isError: true,
    };
  }
});

// Connect stdio transport and handle shutdown gracefully
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Codex MCP Server running on stdio transport');
}

run().catch((error) => {
  console.error('Fatal error starting Codex MCP Server:', error);
  process.exit(1);
});
