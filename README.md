# Codex MCP Server

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.x-orange.svg)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/License-Apache%202.0-green.svg)](LICENSE)

An open-source [Model Context Protocol](https://modelcontextprotocol.io/) server that bridges MCP clients (Claude Desktop, Cursor, Poke, etc.) with the [Codex CLI](https://github.com/openai/codex) running on your machine.

Run coding tasks, manage conversation threads, fork sessions, and browse historical rolls — all through standard MCP tooling.

## Architecture

```
  MCP Client (Claude / Cursor / Poke)
               │
               ▼  MCP Protocol (stdio or Streamable HTTP)
        ┌──────────────────┐
        │ Codex MCP Server │ ← this project
        └──────────────────┘
               │
               ▼  @openai/codex-sdk
          [Codex CLI]
               │
               ▼  OpenAI API
          [GPT-5.x / o3 / o1]
```

## Prerequisites

- **Node.js 22+** (required for native SQLite bindings)
- **Codex CLI** installed and authenticated — verify with `codex doctor`

## Quick Start

```bash
git clone https://github.com/4dhxm/codex-mcp-server.git
cd codex-mcp-server
npm install
npm run build
```

## Transports

The server supports three transport modes:

### 1. Stdio (Default — for local MCP clients)

```bash
node dist/index.js
```

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "codex": {
      "command": "node",
      "args": ["/absolute/path/to/codex-mcp-server/dist/index.js"]
    }
  }
}
```

### 2. Streamable HTTP (Recommended for remote connections)

```bash
node dist/index.js --http
node dist/index.js --http --port 8080
node dist/index.js --http --api-key my-secret-token
```

This starts a standard HTTP server at `POST /mcp` using the modern Streamable HTTP transport. Connect from any MCP client that supports remote servers:

```
URL:     http://localhost:3000/mcp
Type:    Streamable HTTP
Auth:    Bearer <your-api-key>
```

For remote MCP clients like Claude Desktop:

```json
{
  "mcpServers": {
    "codex": {
      "url": "https://your-server.onrender.com/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

### 3. SSE (Legacy — deprecated)

```bash
node dist/index.js --sse
```

SSE transport is deprecated by the MCP specification. Use `--http` instead.

## Authentication

API key auth is enabled by default for HTTP and SSE transports.

**Provide a key** via `--api-key <key>` flag or `CODEX_MCP_API_KEY` env var. If neither is set, a random key is generated and printed on startup.

**How clients send the key** — any of these work:

| Method | Example |
|--------|---------|
| `Authorization` header | `Authorization: Bearer sk-abc123` |
| `x-api-key` header | `x-api-key: sk-abc123` |
| Query parameter | `?apiKey=sk-abc123` |

The server intentionally avoids returning `WWW-Authenticate` headers and does not serve OAuth discovery endpoints (`.well-known/*`). This prevents MCP clients from attempting OAuth flows and ensures simple Bearer token auth works cleanly.

## Deployment

### Render (Recommended — Free Tier)

The easiest way to deploy remotely:

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → **New Web Service** → connect your repo
3. Render auto-detects the `render.yaml` blueprint:
   - Build: `npm install && npm run build`
   - Start: `node dist/index.js --http`
4. Set environment variables in the Render dashboard:
   - `CODEX_MCP_API_KEY` — your API key
   - `OPENAI_API_KEY` — for the Codex SDK

Your server URL will be `https://codex-mcp-server.onrender.com/mcp`.

> **Note:** Free-tier services sleep after 15 minutes of inactivity. First request after sleep takes ~30s. Use [UptimeRobot](https://uptimerobot.com) to ping `/health` every 5 minutes to keep it awake.

### Other Hosting Options

| Platform | Free? | Notes |
|----------|-------|-------|
| **Render** | ✅ 750 hrs/mo | Best option — real Node.js process, no request timeout, unbuffered streaming |
| **Cloudflare Workers** | ✅ 100K req/day | First-class MCP support, but requires rewriting to Workers API |
| **Hugging Face Spaces** | ✅ | Docker container, 48h sleep timeout, use port 7860 |
| **Google Cloud Run** | ✅ 2M req/mo | Good but more complex setup |
| Vercel | ⚠️ | Serverless — 300s timeout, buffering issues with streaming |
| Railway | ❌ | No free tier |
| Fly.io | ❌ | No free tier |

### Manual Tunneling

For quick testing without deploying:

```bash
# Start the server
node dist/index.js --http --api-key my-key

# In another terminal, tunnel with ngrok (paid) or alternatives
ngrok http 3000
# or
ssh -R 80:localhost:3000 nokey@localhost.run
```

## Tools

| Tool | Description |
|------|-------------|
| `codex_task` / `codex_run` | Run a coding task in a new thread |
| `codex_start_thread` | Initialize a thread without running a turn |
| `codex_run_turn` / `codex_continue` / `codex_continue_thread` | Send a follow-up prompt to an existing thread |
| `codex_list_threads` | List active/archived threads from local SQLite |
| `codex_get_thread` | Get metadata and conversation history |
| `codex_fork_thread` | Clone a thread's history into a new session |
| `codex_archive_thread` | Archive a thread |
| `codex_unarchive_thread` | Unarchive a thread |
| `codex_interrupt` / `codex_interrupt_turn` | Abort a running turn |

## Development

```bash
npm run watch   # auto-compile on changes
npm run dev     # build + start in HTTP mode
```

## License

[Apache 2.0](LICENSE)
