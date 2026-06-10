import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
    throw new Error("Tool not found: " + name);
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

/**
 * Spawns ngrok locally and polls its admin API to extract the public tunnel URL.
 */
function startNgrok(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    console.error(`Starting ngrok tunnel for port ${port}...`);
    const ngrokProcess = spawn('npx', ['ngrok', 'http', port.toString()]);
    let resolved = false;
    let errorOutput = '';

    // Capture stdout and stderr to parse error reasons
    ngrokProcess.stdout.on('data', (data) => {
      errorOutput += data.toString();
    });
    ngrokProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    const interval = setInterval(async () => {
      try {
        const response = await fetch('http://127.0.0.1:4040/api/tunnels');
        if (response.ok) {
          const data = (await response.json()) as any;
          const tunnel = data.tunnels?.find(
            (t: any) => t.proto === 'https' || t.proto === 'http'
          );
          if (tunnel && tunnel.public_url) {
            clearInterval(interval);
            resolved = true;
            resolve(tunnel.public_url);
          }
        }
      } catch (err) {
        // API not ready yet
      }
    }, 1000);

    // Timeout after 15 seconds
    setTimeout(() => {
      if (!resolved) {
        clearInterval(interval);
        ngrokProcess.kill();
        reject(new Error('ngrok tunnel startup timed out'));
      }
    }, 15000);

    ngrokProcess.on('error', (err) => {
      clearInterval(interval);
      reject(err);
    });

    ngrokProcess.on('exit', (code) => {
      clearInterval(interval);
      if (!resolved) {
        let msg = `ngrok exited with code ${code}.`;
        
        console.error(`\n❌ [ngrok Error] Tunnel startup failed.`);
        if (errorOutput) {
          console.error(`Error Output:\n${errorOutput.trim()}`);
        }
        
        // Print helper setup instructions to minimize user friction
        console.error(`\n💡 This usually means your ngrok authtoken is missing or invalid.`);
        console.error(`To fix this and authenticate ngrok (free):`);
        console.error(`1. Sign up/Log in at: https://dashboard.ngrok.com`);
        console.error(`2. Copy your Authtoken from: https://dashboard.ngrok.com/get-started/your-authtoken`);
        console.error(`3. Save the token locally by running:`);
        console.error(`   npx ngrok config add-authtoken <YOUR_TOKEN>\n`);
        
        reject(new Error(msg));
      }
    });
  });
}

/**
 * Spawns localhost.run (SSH-based reverse tunnel) to create a public secure URL
 * without warnings or account registration.
 */
function startLocalhostRun(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    console.error(`Starting localhost.run tunnel for port ${port}...`);
    const sshProcess = spawn('ssh', [
      '-o',
      'StrictHostKeyChecking=no',
      '-R',
      `80:localhost:${port}`,
      'nokey@localhost.run',
    ]);
    let resolved = false;

    sshProcess.stdout.on('data', (data) => {
      const output = data.toString();
      // Look for lhr.life HTTPS URL: e.g. "https://xxxx.lhr.life"
      const match = output.match(/https:\/\/[a-zA-Z0-9.-]+\.lhr\.life/);
      if (match && !resolved) {
        resolved = true;
        resolve(match[0]);
      }
    });

    // Timeout after 15 seconds
    setTimeout(() => {
      if (!resolved) {
        sshProcess.kill();
        reject(new Error('localhost.run tunnel startup timed out'));
      }
    }, 15000);

    sshProcess.on('error', (err) => {
      reject(err);
    });

    sshProcess.on('exit', (code) => {
      if (!resolved) {
        reject(new Error(`localhost.run tunnel exited with code ${code}`));
      }
    });
  });
}

// Parse command line arguments
const args = process.argv.slice(2);
const sseMode =
  args.includes('--sse') ||
  (args.includes('--transport') &&
    args[args.indexOf('--transport') + 1] === 'sse');
const portIndex = args.indexOf('--port');
const port =
  portIndex !== -1 && args[portIndex + 1]
    ? parseInt(args[portIndex + 1], 10)
    : 3000;
const tunnelMode = args.includes('--tunnel') || args.includes('--ngrok');

// Tunnel provider selection: default is 'localhost-run' to avoid warning pages
const providerIndex = args.indexOf('--tunnel-provider');
const tunnelProvider =
  providerIndex !== -1 && args[providerIndex + 1]
    ? args[providerIndex + 1]
    : 'localhost-run';

// API Key configuration
const apiKeyIndex = args.indexOf('--api-key');
let apiKey =
  apiKeyIndex !== -1 && args[apiKeyIndex + 1]
    ? args[apiKeyIndex + 1]
    : process.env.CODEX_MCP_API_KEY;

if (sseMode && !apiKey) {
  // Auto-generate a secure random API key if none is provided
  apiKey = randomUUID().replace(/-/g, '');
  console.error(`\n🛡️  [SECURITY] No API key provided. Auto-generated a secure API key for this session:`);
  console.error(`👉 API Key: ${apiKey}\n`);
}

// Start the server using the configured transport
async function run() {
  if (sseMode) {
    const app = createMcpExpressApp() as any;
    const transports: Record<string, SSEServerTransport> = {};

    // Authentication middleware
    if (apiKey) {
      app.use((req: any, res: any, next: any) => {
        const requestKey =
          req.headers['x-api-key'] ||
          req.headers['authorization']?.replace('Bearer ', '') ||
          req.query.apiKey;

        if (requestKey !== apiKey) {
          console.error(`Unauthorized access attempt from ${req.ip} blocked`);
          res.status(401).send('Unauthorized: Invalid or missing API Key');
          return;
        }
        next();
      });
    }

    app.get('/sse', async (req: any, res: any) => {
      console.error('SSE connection established');
      
      // Inject apiKey into the relative redirection endpoint so subsequent POST requests
      // maintain authentication when resolved by standard MCP clients
      const messageEndpoint = apiKey ? `/messages?apiKey=${apiKey}` : '/messages';
      const transport = new SSEServerTransport(messageEndpoint, res);
      transports[transport.sessionId] = transport;

      res.on('close', () => {
        console.error(`SSE connection closed for session ${transport.sessionId}`);
        delete transports[transport.sessionId];
      });

      await server.connect(transport);
    });

    app.post('/messages', async (req: any, res: any) => {
      const sessionId = req.query.sessionId as string;
      const transport = transports[sessionId];
      if (transport) {
        await transport.handlePostMessage(req, res, req.body);
      } else {
        res.status(400).send('No transport found for sessionId');
      }
    });

    app.listen(port, async () => {
      console.error(`Codex MCP Server listening on port ${port}`);
      console.error(`- SSE establishment endpoint: http://localhost:${port}/sse`);
      console.error(`- Message POST endpoint: http://localhost:${port}/messages`);

      if (tunnelMode) {
        try {
          let publicUrl: string;
          if (tunnelProvider === 'ngrok') {
            publicUrl = await startNgrok(port);
          } else {
            publicUrl = await startLocalhostRun(port);
          }
          console.error(`\n==============================================`);
          console.error(`${tunnelProvider} tunnel established successfully!`);
          console.error(`Public URL: ${publicUrl}`);
          console.error(`- SSE endpoint: ${publicUrl}/sse?apiKey=${apiKey}`);
          console.error(`- Message endpoint: ${publicUrl}/messages?apiKey=${apiKey}`);
          console.error(`==============================================\n`);
        } catch (err: any) {
          console.error(`Failed to start ${tunnelProvider} tunnel:`, err.message || err);
        }
      }
    });
  } else {
    // Default: Stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Codex MCP Server running on stdio transport');
  }
}

run().catch((error) => {
  console.error('Fatal error starting Codex MCP Server:', error);
  process.exit(1);
});
