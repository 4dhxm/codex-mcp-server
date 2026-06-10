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
import { tools } from './tools.js';
import { createAuthMiddleware, blockOAuthDiscovery } from './auth.js';

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
 * Spawns localhost.run (SSH-based reverse tunnel) to create a public secure URL
 * without warnings or account registration.
 */
function startLocalhostRun(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    console.error(`\n🔄 Starting localhost.run tunnel for port ${port}...`);
    const sshProcess = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=60',
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
  apiKey = randomUUID().replace(/-/g, '');
  console.error(`\n🛡️  No API key provided. Generated one for this session:`);
  console.error(`👉 ${apiKey}\n`);
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
        const publicUrl = await startLocalhostRun(port);
        console.error(`\n==============================================`);
        console.error(`🌐 localhost.run tunnel established successfully!`);
        console.error(`Public URL: ${publicUrl}`);
        console.error(`MCP URL:    ${publicUrl}/mcp`);
        console.error(`==============================================\n`);
      } catch (err: any) {
        console.error(`Failed to start localhost.run tunnel:`, err.message || err);
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
