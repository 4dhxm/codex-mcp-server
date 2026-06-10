# Codex MCP Server

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.x-orange.svg)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/License-Apache%202.0-green.svg)](LICENSE)

An open-source [Model Context Protocol](https://modelcontextprotocol.io/) server that bridges MCP clients (Claude Desktop, Cursor, Poke, etc.) with the [Codex CLI](https://github.com/openai/codex) running on your machine.

Run coding tasks, manage conversation threads, fork sessions, and browse historical rolls — all through standard MCP tooling.

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

## Running the Server

### 1. Local Transport (stdio)
For MCP clients running on the same machine (like Claude Desktop or Cursor).

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

### 2. Remote Transport with Auto-Tunnel (Streamable HTTP + localhost.run)
For exposing your local Codex installation to remote MCP clients (like Poke or a remote device) **without dealing with routers or ngrok accounts**.

```bash
node dist/index.js --http --tunnel
```
*This starts the server and automatically spawns a free SSH reverse tunnel via `localhost.run`.*

You can also explicitly set your API key:
```bash
node dist/index.js --http --tunnel --api-key my-secret-token
```

You will see output like this:
```
==============================================
🌐 localhost.run tunnel established successfully!
Public URL: https://a1b2c3d4.lhr.life
MCP URL:    https://a1b2c3d4.lhr.life/mcp
==============================================
```

Connect from your remote MCP client:
```
URL:     https://a1b2c3d4.lhr.life/mcp
Type:    Streamable HTTP
Auth:    Bearer <your-api-key>
```

### 3. Local HTTP Network Transport
To run over HTTP without a public tunnel (for your local network):

```bash
node dist/index.js --http --port 8080
```

## Authentication

API key auth is enabled by default for HTTP mode to protect your local machine from unauthorized remote access.

**Provide a key** via `--api-key <key>` flag or `CODEX_MCP_API_KEY` env var. If neither is set, a random secure key is generated and printed on startup.

**How clients send the key** — any of these work:

| Method | Example |
|--------|---------|
| `Authorization` header | `Authorization: Bearer sk-abc123` |
| `x-api-key` header | `x-api-key: sk-abc123` |
| Query parameter | `?apiKey=sk-abc123` |

The server intentionally avoids returning `WWW-Authenticate` headers to prevent MCP clients from attempting OAuth flows, ensuring simple Bearer token auth works cleanly.

## Tools

| Tool | Description |
|------|-------------|
| `codex_task` / `codex_run` | Run a coding task in a new thread |
| `codex_start_thread` | Initialize a thread without running a turn |
| `codex_run_turn` / `codex_continue` | Send a follow-up prompt to an existing thread |
| `codex_list_threads` | List active/archived threads from local SQLite |
| `codex_get_thread` | Get metadata and conversation history |
| `codex_fork_thread` | Clone a thread's history into a new session |
| `codex_archive_thread` | Archive a thread |
| `codex_unarchive_thread` | Unarchive a thread |
| `codex_interrupt` / `codex_interrupt_turn` | Abort a running turn |

## License

[Apache 2.0](LICENSE)
