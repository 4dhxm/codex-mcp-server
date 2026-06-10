import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tools } from './tools.js';
import { createAuthMiddleware, blockOAuthDiscovery } from './auth.js';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function createServer(): Server {
  const server = new Server(
    { name: 'codex-mcp-server', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

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

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      throw new Error("Tool not found: " + name);
    }

    try {
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

  return server;
}

/**
 * Spawns Cloudflare Quick Tunnels (cloudflared) to create a highly stable public URL
 * without warnings or account registration.
 */
function startCloudflareTunnel(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    console.error(`\n🔄 Starting Cloudflare tunnel for port ${port}...`);
    
    // cloudflared outputs its logs to stderr
    const cfProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`]);
    let resolved = false;

    const handleOutput = (data: any) => {
      const output = data.toString();
      // Look for trycloudflare.com HTTPS URL
      const match = output.match(/https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        resolve(match[0]);
      }
    };

    cfProcess.stderr.on('data', handleOutput);
    cfProcess.stdout.on('data', handleOutput);

    cfProcess.on('error', (err: any) => {
      if (err.code === 'ENOENT') {
        reject(new Error(
          "cloudflared is not installed.\n\n" +
          "👉 Please install it first by running:\n" +
          "   brew install cloudflared\n"
        ));
      } else {
        reject(err);
      }
    });

    // Timeout after 15 seconds if no URL is found
    setTimeout(() => {
      if (!resolved) {
        cfProcess.kill();
        reject(new Error('Cloudflare tunnel startup timed out waiting for URL.'));
      }
    }, 15000);

    cfProcess.on('exit', (code) => {
      if (!resolved) {
        reject(new Error(`Cloudflare tunnel exited prematurely with code ${code}`));
      }
    });
  });
}

// ── CLI argument parsing ────────────────────────────────────────

const args = process.argv.slice(2);

function getFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

function getFlagValue(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

const transportMode = getFlag('http')
  ? 'http'
  : getFlag('sse')
    ? 'sse'
    : 'stdio';

const tunnelMode = getFlag('tunnel');

const port = parseInt(getFlagValue('port') || '3000', 10);

let apiKey =
  getFlagValue('api-key') || process.env.CODEX_MCP_API_KEY;

if (transportMode !== 'stdio' && !apiKey) {
  // Check if we already saved one to .env previously
  const envPath = path.join(projectRoot, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const match = envContent.match(/CODEX_MCP_API_KEY=(.+)/);
    if (match && match[1]) {
      apiKey = match[1].trim();
    }
  }

  if (!apiKey) {
    apiKey = randomUUID().replace(/-/g, '');
    
    // Save it to .env so it's persistent across restarts
    const envLine = `CODEX_MCP_API_KEY=${apiKey}\n`;
    fs.appendFileSync(envPath, envLine);
    
    console.error(`\n🛡️  No API key provided. Generated a secure persistent key:`);
    console.error(`👉 ${apiKey}`);
    console.error(`💾 Saved to .env file for future runs.\n`);
  } else {
    console.error(`\n🔑 Loaded persistent API key from .env file.\n`);
  }
}

// ── Streamable HTTP transport (recommended for production) ──────

async function startHttpServer() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  blockOAuthDiscovery(app);

  if (apiKey) {
    app.use(createAuthMiddleware({ apiKey }));
  }

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', transport: 'streamable-http' });
  });

  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    await server.connect(transport);

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };

    await transport.handleRequest(req, res, req.body);

    if (transport.sessionId) {
      sessions.set(transport.sessionId, { transport, server });
    }
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res);
      return;
    }
    res.status(400).json({ error: 'Missing or invalid session ID for GET request' });
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res);
      return;
    }
    res.status(400).json({ error: 'Missing or invalid session ID for DELETE request' });
  });

  app.listen(port, async () => {
    console.error(`Codex MCP Server (Streamable HTTP) listening on port ${port}`);
    console.error(`  POST/GET/DELETE http://localhost:${port}/mcp`);
    console.error(`  Health check:   http://localhost:${port}/health`);
    if (apiKey) {
      console.error(`\n  Authorization: Bearer ${apiKey}`);
    }

    if (tunnelMode) {
      try {
        const publicUrl = await startCloudflareTunnel(port);
        console.error(`\n==============================================`);
        console.error(`🌐 Cloudflare tunnel established successfully!`);
        console.error(`Public URL: ${publicUrl}`);
        console.error(`MCP URL:    ${publicUrl}/mcp`);
        console.error(`==============================================\n`);
      } catch (err: any) {
        console.error(`\n❌ Failed to start tunnel:`, err.message || err);
      }
    }
  });
}

// ── Legacy SSE transport ────────────────────────────────────────

async function startSseServer() {
  const app = express();
  const transports: Record<string, SSEServerTransport> = {};

  app.use(cors());
  app.use(express.json());

  blockOAuthDiscovery(app);

  if (apiKey) {
    app.use(createAuthMiddleware({ apiKey }));
  }

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', transport: 'sse' });
  });

  app.get('/sse', async (req: any, res: any) => {
    console.error('SSE connection established');
    const messageEndpoint = apiKey ? `/messages?apiKey=${apiKey}` : '/messages';
    const transport = new SSEServerTransport(messageEndpoint, res);
    transports[transport.sessionId] = transport;

    res.on('close', () => {
      console.error(`SSE connection closed for session ${transport.sessionId}`);
      delete transports[transport.sessionId];
    });

    const server = createServer();
    await server.connect(transport);
  });

  app.post('/messages', async (req: any, res: any) => {
    const parsedUrl = new URL(req.url || '', 'http://localhost');
    const sessionId = parsedUrl.searchParams.get('sessionId') as string;
    const transport = transports[sessionId];
    if (transport) {
      await transport.handlePostMessage(req, res, req.body);
    } else {
      res.status(400).send('No transport found for sessionId');
    }
  });

  app.listen(port, () => {
    console.error(`Codex MCP Server (SSE - legacy) listening on port ${port}`);
    console.error(`  SSE endpoint:     http://localhost:${port}/sse`);
    console.error(`  Message endpoint: http://localhost:${port}/messages`);
    if (apiKey) {
      console.error(`\n  Authorization: Bearer ${apiKey}`);
    }
    console.error(`\n⚠️  SSE transport is deprecated. Use --http for Streamable HTTP.`);
  });
}

// ── Stdio transport (local MCP clients) ─────────────────────────

async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Codex MCP Server running on stdio transport');
}

// ── Entry point ─────────────────────────────────────────────────

async function run() {
  switch (transportMode) {
    case 'http':
      await startHttpServer();
      break;
    case 'sse':
      await startSseServer();
      break;
    default:
      await startStdio();
  }
}

run().catch((error) => {
  console.error('Fatal error starting Codex MCP Server:', error);
  process.exit(1);
});
