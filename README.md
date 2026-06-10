# Codex Model Context Protocol (MCP) Server

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.x-orange.svg)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/License-Apache%202.0-green.svg)](LICENSE)

A clean, scalable, and open-source Model Context Protocol (MCP) server that provides programmatic access to Codex agent threads, tasks, and history. 

This server acts as a bridge between MCP clients (such as Claude Desktop, Cursor, or Windsurf) and your local Codex CLI installation, exposing tools to execute autonomous coding tasks, manage conversation threads, fork sessions, and inspect historical rolls directly from the local SQLite state.

---

## Architecture

```
  MCP Client (Claude / Cursor)
              │
              ▼  MCP Protocol (stdio JSON-RPC)
       [Codex MCP Server]
              │
              ▼  @openai/codex-sdk
         [Codex CLI] (Running locally)
              │
              ▼  OpenAI API
         [GPT-5.x / o3 / o1]
```

---

## Prerequisites

Before setting up the MCP server, ensure you have the following installed on your local machine:

1. **Node.js**: Version `18.x` or higher (we recommend `22+` to leverage native SQLite bindings).
2. **Codex CLI**: Install and authenticate the Codex CLI on your machine.
   ```bash
   codex doctor
   ```
   *Make sure `codex doctor` reports a healthy installation and active authentication status.*

---

## Installation

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/4dhxm/codex-mcp-server.git
   cd codex-mcp-server
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Build the Server**:
   ```bash
   npm run build
   ```

---

## Configuration

To use this server with your favorite MCP client, add it to your client's configuration file.

### 1. Claude Desktop
Add the server configuration to your `claude_desktop_config.json` file.
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "codex-mcp-server": {
      "command": "node",
      "args": [
        "/absolute/path/to/codex-mcp-server/dist/index.js"
      ]
    }
  }
}
```

### 2. Cursor
1. Go to **Settings** > **Features** > **MCP**.
2. Click **+ Add New MCP Server**.
3. Fill in the fields:
   - **Name**: `codex-mcp-server`
   - **Type**: `command`
   - **Command**: `node /absolute/path/to/codex-mcp-server/dist/index.js`
4. Click **Save**.

---

## Tools Exposed

This server exposes the following tools to MCP clients:

### 1. Running Tasks
* **`codex_task`** / **`codex_run`**: Starts a new thread, executes a complete coding task from a prompt, and returns the final response.
  - **Arguments**:
    - `prompt` (string, required): The coding task or prompt.
    - `workingDirectory` (string, optional): Working root for the agent.
    - `model` (string, optional): Model override (e.g. `o3`, `o1`).
    - `sandboxMode` (string, optional): `'read-only' | 'workspace-write' | 'danger-full-access'`.
    - `webSearchEnabled` (boolean, optional): Enable web search.

### 2. Thread Lifecycle
* **`codex_start_thread`**: Initializes a conversation session but defers executing turns.
  - **Arguments**: `workingDirectory`, `model`, `sandboxMode`, `webSearchEnabled`.
* **`codex_run_turn`** / **`codex_continue`** / **`codex_continue_thread`**: Send a follow-up prompt to an existing thread.
  - **Arguments**:
    - `threadId` (string, required): The ID of the thread to continue.
    - `prompt` (string, required): The prompt for the new turn.
    - `model` (string, optional).

### 3. Session Utilities
* **`codex_list_threads`**: Lists all active and archived conversation threads directly from your local `state_5.sqlite` cache.
  - **Arguments**:
    - `limit` (number, optional, default: `50`): Max threads to return.
    - `includeArchived` (boolean, optional, default: `false`): Include archived threads.
* **`codex_get_thread`**: Returns metadata and the complete, parsed conversation history (user & assistant messages) of a thread.
  - **Arguments**:
    - `threadId` (string, required): The thread ID.
* **`codex_fork_thread`**: Clones an existing thread's conversation history into a new thread ID, allowing you to branch off from previous sessions.
  - **Arguments**:
    - `threadId` (string, required): The source thread ID to fork.
    - `cwd` (string, optional): Optional working directory override.
* **`codex_archive_thread`**: Archives an active thread, moving its rollout files to `~/.codex/archived_sessions`.
  - **Arguments**:
    - `threadId` (string, required).
* **`codex_unarchive_thread`**: Unarchives a thread, moving it back to active directories.
  - **Arguments**:
    - `threadId` (string, required).
* **`codex_interrupt`** / **`codex_interrupt_turn`**: Programmatically aborts the running turn of a thread via `AbortSignals`.
  - **Arguments**:
    - `threadId` (string, required).

---

## Local Development & Testing

We provide a built-in verification script to test database connectivity, rollout path parsing, and JSONL log parsing locally:

1. **Run the Verification Script**:
   ```bash
   npm run build && node dist/test-db.js
   ```
   *This will query your local `~/.codex/state_5.sqlite` database, print the 5 most recent threads, and display message histories.*

2. **Watcher Mode**:
   For auto-compiling typescript files while editing:
   ```bash
   npm run watch
   ```

---

## License

This project is open-sourced under the [Apache 2.0 License](LICENSE).
