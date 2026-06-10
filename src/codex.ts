import { Codex, Thread, ThreadOptions } from '@openai/codex-sdk';
import { DatabaseSync } from 'node:sqlite';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execAsync = promisify(exec);

const CODEX_DIR = path.join(os.homedir(), '.codex');
const DB_PATH = path.join(CODEX_DIR, 'state_5.sqlite');

export interface ThreadMetadata {
  id: string;
  title: string;
  cwd: string;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  tokensUsed: number;
  archived: boolean;
  firstUserMessage: string;
  preview: string;
}

export interface ThreadMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  phase?: string;
}

export interface ThreadDetails extends ThreadMetadata {
  history: ThreadMessage[];
}

interface ActiveRun {
  abortController: AbortController;
  thread: Thread;
}

// Global registers for managing running turns and pending threads
const activeRuns = new Map<string, ActiveRun>();
const pendingThreads = new Map<string, { thread: Thread; options?: ThreadOptions }>();

/**
 * Executes a sqlite query on the Codex database.
 */
function queryDb<T>(query: string, params: any[] = []): T[] {
  if (!fs.existsSync(DB_PATH)) {
    return [];
  }
  try {
    const db = new DatabaseSync(DB_PATH);
    const stmt = db.prepare(query);
    return stmt.all(...params) as T[];
  } catch (error) {
    console.error('Database query failed:', error);
    return [];
  }
}

/**
 * Lists all sessions/threads from the SQLite database.
 */
export function listThreads(limit = 50, includeArchived = false): ThreadMetadata[] {
  let query = `
    SELECT id, title, cwd, model, created_at as createdAt, updated_at as updatedAt, 
           tokens_used as tokensUsed, archived, first_user_message as firstUserMessage, preview
    FROM threads
  `;
  const params: any[] = [];

  if (!includeArchived) {
    query += ' WHERE archived = 0';
  }

  query += ' ORDER BY updated_at DESC LIMIT ?';
  params.push(limit);

  const rows = queryDb<any>(query, params);
  return rows.map(row => ({
    ...row,
    archived: Boolean(row.archived)
  }));
}

/**
 * Parses the conversation history from a rollout JSONL file.
 */
function parseRolloutHistory(rolloutPath: string): ThreadMessage[] {
  const history: ThreadMessage[] = [];
  if (!fs.existsSync(rolloutPath)) {
    return history;
  }

  try {
    const content = fs.readFileSync(rolloutPath, 'utf8');
    const lines = content.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'event_msg' && event.payload) {
          const payload = event.payload;
          if (payload.type === 'user_message') {
            history.push({
              role: 'user',
              content: payload.message || '',
              timestamp: event.timestamp
            });
          } else if (payload.type === 'agent_message') {
            history.push({
              role: 'assistant',
              content: payload.message || '',
              timestamp: event.timestamp,
              phase: payload.phase
            });
          }
        }
      } catch (err) {
        // Skip malformed lines
      }
    }
  } catch (error) {
    console.error(`Failed to parse history from ${rolloutPath}:`, error);
  }

  return history;
}

/**
 * Resolves a thread's JSONL path by querying sqlite or searching disk.
 */
function findRolloutPath(threadId: string): string | null {
  const rows = queryDb<{ rollout_path: string }>(
    'SELECT rollout_path FROM threads WHERE id = ?',
    [threadId]
  );
  if (rows.length > 0 && fs.existsSync(rows[0].rollout_path)) {
    return rows[0].rollout_path;
  }

  // Fallback: search directory recursively
  const searchDir = (dir: string): string | null => {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = searchDir(fullPath);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) {
        return fullPath;
      }
    }
    return null;
  };

  return searchDir(path.join(CODEX_DIR, 'sessions')) || searchDir(path.join(CODEX_DIR, 'archived_sessions'));
}

/**
 * Gets details of a thread including metadata and message history.
 */
export function getThread(threadId: string): ThreadDetails | null {
  const rows = queryDb<any>(
    `SELECT id, title, cwd, model, created_at as createdAt, updated_at as updatedAt, 
            tokens_used as tokensUsed, archived, first_user_message as firstUserMessage, preview
     FROM threads WHERE id = ?`,
    [threadId]
  );

  const rolloutPath = findRolloutPath(threadId);
  const history = rolloutPath ? parseRolloutHistory(rolloutPath) : [];

  if (rows.length === 0) {
    if (history.length > 0) {
      // Create ad-hoc metadata if not in SQLite yet
      return {
        id: threadId,
        title: history[0]?.content.substring(0, 50) || 'Untitled Thread',
        cwd: '',
        model: null,
        createdAt: 0,
        updatedAt: 0,
        tokensUsed: 0,
        archived: false,
        firstUserMessage: history[0]?.content || '',
        preview: history[history.length - 1]?.content.substring(0, 100) || '',
        history
      };
    }
    return null;
  }

  const metadata = rows[0];
  return {
    ...metadata,
    archived: Boolean(metadata.archived),
    history
  };
}

/**
 * Prepares options for the Codex CLI/SDK wrapper.
 */
function getCodexOptions(): any {
  // Use user workspace settings or env overrides
  return {};
}

/**
 * Starts a new pending thread instance.
 */
export function startThread(options?: ThreadOptions): { threadId: string; status: string } {
  const tempId = randomUUID();
  const codex = new Codex(getCodexOptions());
  const thread = codex.startThread(options);
  pendingThreads.set(tempId, { thread, options });
  return { threadId: tempId, status: 'initialized' };
}

/**
 * Registers a running turn under a thread ID and returns its AbortSignal.
 */
function registerRun(threadId: string, thread: Thread): AbortSignal {
  const abortController = new AbortController();
  activeRuns.set(threadId, { abortController, thread });
  return abortController.signal;
}

/**
 * Unregisters a running turn.
 */
function unregisterRun(threadId: string) {
  activeRuns.delete(threadId);
}

/**
 * Interrupts an active turn for a thread.
 */
export function interruptTurn(threadId: string): boolean {
  const active = activeRuns.get(threadId);
  if (active) {
    active.abortController.abort();
    activeRuns.delete(threadId);
    return true;
  }
  return false;
}

/**
 * Runs a turn on a thread, resolving temp IDs to real IDs as needed.
 */
export async function runTurn(
  threadId: string,
  prompt: string,
  options?: ThreadOptions
): Promise<{ threadId: string; response: string; tokensUsed?: number }> {
  let thread: Thread;
  let isTemp = false;

  // Resolve pending thread
  const pending = pendingThreads.get(threadId);
  if (pending) {
    thread = pending.thread;
    isTemp = true;
  } else {
    const codex = new Codex(getCodexOptions());
    thread = codex.resumeThread(threadId, options);
  }

  const signal = registerRun(threadId, thread);

  try {
    const turn = await thread.run(prompt, { signal });
    const realId = thread.id || threadId;

    if (isTemp) {
      pendingThreads.delete(threadId);
    }

    return {
      threadId: realId,
      response: turn.finalResponse,
      tokensUsed: turn.usage?.output_tokens ? turn.usage.input_tokens + turn.usage.output_tokens : undefined
    };
  } finally {
    unregisterRun(threadId);
  }
}

/**
 * Starts a new thread and runs the initial task.
 */
export async function runTask(
  prompt: string,
  options?: ThreadOptions
): Promise<{ threadId: string; response: string; tokensUsed?: number }> {
  const codex = new Codex(getCodexOptions());
  const thread = codex.startThread(options);
  
  // Register run under a temp ID since thread.id isn't resolved until run completes
  const tempId = randomUUID();
  const signal = registerRun(tempId, thread);

  try {
    const turn = await thread.run(prompt, { signal });
    const realId = thread.id || tempId;
    return {
      threadId: realId,
      response: turn.finalResponse,
      tokensUsed: turn.usage?.output_tokens ? turn.usage.input_tokens + turn.usage.output_tokens : undefined
    };
  } finally {
    unregisterRun(tempId);
  }
}

/**
 * Archives a thread using the CLI.
 */
export async function archiveThread(threadId: string): Promise<boolean> {
  try {
    await execAsync(`codex archive ${threadId}`);
    return true;
  } catch (error) {
    console.error(`Failed to archive thread ${threadId}:`, error);
    
    // Fallback: move file directly if CLI fails
    const srcPath = findRolloutPath(threadId);
    if (srcPath) {
      const destDir = path.join(CODEX_DIR, 'archived_sessions');
      fs.mkdirSync(destDir, { recursive: true });
      const destPath = path.join(destDir, path.basename(srcPath));
      fs.renameSync(srcPath, destPath);
      
      // Update SQLite if available
      try {
        const db = new DatabaseSync(DB_PATH);
        db.prepare('UPDATE threads SET archived = 1, rollout_path = ? WHERE id = ?').run(destPath, threadId);
      } catch (dbErr) {
        // Ignore db failure if fallback works
      }
      return true;
    }
    return false;
  }
}

/**
 * Unarchives a thread using the CLI.
 */
export async function unarchiveThread(threadId: string): Promise<boolean> {
  try {
    await execAsync(`codex unarchive ${threadId}`);
    return true;
  } catch (error) {
    console.error(`Failed to unarchive thread ${threadId}:`, error);
    
    const srcPath = findRolloutPath(threadId);
    if (srcPath && srcPath.includes('archived_sessions')) {
      const now = new Date();
      const year = now.getFullYear().toString();
      const month = (now.getMonth() + 1).toString().padStart(2, '0');
      const day = now.getDate().toString().padStart(2, '0');
      
      const destDir = path.join(CODEX_DIR, 'sessions', year, month, day);
      fs.mkdirSync(destDir, { recursive: true });
      const destPath = path.join(destDir, path.basename(srcPath));
      fs.renameSync(srcPath, destPath);
      
      try {
        const db = new DatabaseSync(DB_PATH);
        db.prepare('UPDATE threads SET archived = 0, rollout_path = ? WHERE id = ?').run(destPath, threadId);
      } catch (dbErr) {
        // Ignore db failure
      }
      return true;
    }
    return false;
  }
}

/**
 * Forks a thread by duplicating its JSONL file with a new session ID.
 */
export async function forkThread(
  sourceThreadId: string,
  options?: { cwd?: string }
): Promise<string> {
  const srcPath = findRolloutPath(sourceThreadId);
  if (!srcPath || !fs.existsSync(srcPath)) {
    throw new Error(`Source thread ${sourceThreadId} history file not found.`);
  }

  const newThreadId = randomUUID();
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');

  // Format timestamp for filename: e.g. 2026-06-10T15-44-55
  const timestamp = now.toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/:/g, '-');
  
  const destDir = path.join(CODEX_DIR, 'sessions', year, month, day);
  fs.mkdirSync(destDir, { recursive: true });
  
  // Format filename: rollout-<TIMESTAMP>-<UUID>.jsonl
  const newFilename = `rollout-${timestamp}-${newThreadId}.jsonl`;
  const destPath = path.join(destDir, newFilename);

  // Read lines from source, update session_meta with the new ID
  const lines = fs.readFileSync(srcPath, 'utf8').split('\n');
  if (lines.length > 0 && lines[0].trim()) {
    try {
      const meta = JSON.parse(lines[0]);
      if (meta.type === 'session_meta' && meta.payload) {
        meta.payload.id = newThreadId;
        meta.payload.timestamp = now.toISOString();
        if (options?.cwd) {
          meta.payload.cwd = options.cwd;
        }
        lines[0] = JSON.stringify(meta);
      }
    } catch (err) {
      console.warn('Failed to parse metadata line during fork, copying raw file');
    }
  }

  fs.writeFileSync(destPath, lines.join('\n'), 'utf8');
  return newThreadId;
}
