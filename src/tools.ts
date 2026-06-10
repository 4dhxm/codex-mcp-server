import { z } from 'zod';
import * as codex from './codex.js';

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
  handler: (args: any) => Promise<any>;
}

// Common schemas for reuse
const sandboxModeSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional();

const threadOptionsSchema = z.object({
  workingDirectory: z.string().optional(),
  model: z.string().optional(),
  sandboxMode: sandboxModeSchema,
  networkAccessEnabled: z.boolean().optional(),
  webSearchEnabled: z.boolean().optional()
});

export const tools: ToolDefinition[] = [
  // 1. Run complete task / Run coding task
  {
    name: 'codex_task',
    description: 'Run an autonomous coding task in a new Codex thread and return the final response.',
    schema: threadOptionsSchema.extend({
      prompt: z.string().describe('The coding task or prompt for the Codex agent.')
    }),
    handler: async (args) => {
      const { prompt, ...options } = args;
      const result = await codex.runTask(prompt, {
        workingDirectory: options.workingDirectory,
        model: options.model,
        sandboxMode: options.sandboxMode,
        networkAccessEnabled: options.networkAccessEnabled,
        webSearchEnabled: options.webSearchEnabled
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'completed',
              threadId: result.threadId,
              response: result.response,
              tokensUsed: result.tokensUsed
            }, null, 2)
          }
        ]
      };
    }
  },
  {
    name: 'codex_run',
    description: 'Alias for codex_task. Runs a task in a new Codex thread.',
    schema: threadOptionsSchema.extend({
      prompt: z.string().describe('The coding task or prompt for the Codex agent.')
    }),
    handler: async (args) => {
      const { prompt, ...options } = args;
      const result = await codex.runTask(prompt, {
        workingDirectory: options.workingDirectory,
        model: options.model,
        sandboxMode: options.sandboxMode,
        networkAccessEnabled: options.networkAccessEnabled,
        webSearchEnabled: options.webSearchEnabled
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'completed',
              threadId: result.threadId,
              response: result.response,
              tokensUsed: result.tokensUsed
            }, null, 2)
          }
        ]
      };
    }
  },

  // 2. Start thread
  {
    name: 'codex_start_thread',
    description: 'Start a new conversation thread session with the Codex agent.',
    schema: threadOptionsSchema,
    handler: async (args) => {
      const result = codex.startThread({
        workingDirectory: args.workingDirectory,
        model: args.model,
        sandboxMode: args.sandboxMode,
        networkAccessEnabled: args.networkAccessEnabled,
        webSearchEnabled: args.webSearchEnabled
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    }
  },

  // 3. Continue / Run turn / Continue thread
  {
    name: 'codex_run_turn',
    description: 'Run a follow-up turn or send a new prompt in an existing Codex thread.',
    schema: threadOptionsSchema.extend({
      threadId: z.string().describe('The ID of the thread to resume.'),
      prompt: z.string().describe('The follow-up prompt or query for the agent.')
    }),
    handler: async (args) => {
      const { threadId, prompt, ...options } = args;
      const result = await codex.runTurn(threadId, prompt, {
        workingDirectory: options.workingDirectory,
        model: options.model,
        sandboxMode: options.sandboxMode,
        networkAccessEnabled: options.networkAccessEnabled,
        webSearchEnabled: options.webSearchEnabled
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'completed',
              threadId: result.threadId,
              response: result.response,
              tokensUsed: result.tokensUsed
            }, null, 2)
          }
        ]
      };
    }
  },
  {
    name: 'codex_continue',
    description: 'Alias for codex_run_turn. Continue an existing conversation thread.',
    schema: threadOptionsSchema.extend({
      threadId: z.string().describe('The ID of the thread to resume.'),
      prompt: z.string().describe('The follow-up prompt or query.')
    }),
    handler: async (args) => {
      const { threadId, prompt, ...options } = args;
      const result = await codex.runTurn(threadId, prompt, {
        workingDirectory: options.workingDirectory,
        model: options.model,
        sandboxMode: options.sandboxMode,
        networkAccessEnabled: options.networkAccessEnabled,
        webSearchEnabled: options.webSearchEnabled
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'completed',
              threadId: result.threadId,
              response: result.response,
              tokensUsed: result.tokensUsed
            }, null, 2)
          }
        ]
      };
    }
  },
  {
    name: 'codex_continue_thread',
    description: 'Alias for codex_run_turn. Continue a thread with a follow-up message.',
    schema: threadOptionsSchema.extend({
      threadId: z.string().describe('The ID of the thread to resume.'),
      prompt: z.string().describe('The follow-up prompt or query.')
    }),
    handler: async (args) => {
      const { threadId, prompt, ...options } = args;
      const result = await codex.runTurn(threadId, prompt, {
        workingDirectory: options.workingDirectory,
        model: options.model,
        sandboxMode: options.sandboxMode,
        networkAccessEnabled: options.networkAccessEnabled,
        webSearchEnabled: options.webSearchEnabled
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'completed',
              threadId: result.threadId,
              response: result.response,
              tokensUsed: result.tokensUsed
            }, null, 2)
          }
        ]
      };
    }
  },

  // 4. List threads
  {
    name: 'codex_list_threads',
    description: 'List historical and active Codex threads querying local session caches.',
    schema: z.object({
      limit: z.number().optional().default(50).describe('Maximum number of threads to list.'),
      includeArchived: z.boolean().optional().default(false).describe('Whether to include archived threads in the list.')
    }),
    handler: async (args) => {
      const threads = codex.listThreads(args.limit, args.includeArchived);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(threads, null, 2)
          }
        ]
      };
    }
  },

  // 5. Get thread details
  {
    name: 'codex_get_thread',
    description: 'Get metadata and full conversation history for a specific Codex thread.',
    schema: z.object({
      threadId: z.string().describe('The ID of the thread to retrieve.')
    }),
    handler: async (args) => {
      const thread = codex.getThread(args.threadId);
      if (!thread) {
        throw new Error(`Thread not found: ${args.threadId}`);
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(thread, null, 2)
          }
        ]
      };
    }
  },

  // 6. Fork thread
  {
    name: 'codex_fork_thread',
    description: 'Fork an existing thread into a new thread by cloning its session history.',
    schema: z.object({
      threadId: z.string().describe('The source thread ID to fork from.'),
      cwd: z.string().optional().describe('Optional working directory override for the new thread.')
    }),
    handler: async (args) => {
      const newThreadId = await codex.forkThread(args.threadId, { cwd: args.cwd });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'forked',
              sourceThreadId: args.threadId,
              newThreadId
            }, null, 2)
          }
        ]
      };
    }
  },

  // 7. Archive thread
  {
    name: 'codex_archive_thread',
    description: 'Archive an active conversation thread.',
    schema: z.object({
      threadId: z.string().describe('The ID of the thread to archive.')
    }),
    handler: async (args) => {
      const success = await codex.archiveThread(args.threadId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success,
              threadId: args.threadId,
              status: success ? 'archived' : 'failed'
            }, null, 2)
          }
        ]
      };
    }
  },

  // 8. Unarchive thread (Bonus)
  {
    name: 'codex_unarchive_thread',
    description: 'Unarchive a previously archived conversation thread.',
    schema: z.object({
      threadId: z.string().describe('The ID of the thread to unarchive.')
    }),
    handler: async (args) => {
      const success = await codex.unarchiveThread(args.threadId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success,
              threadId: args.threadId,
              status: success ? 'unarchived' : 'failed'
            }, null, 2)
          }
        ]
      };
    }
  },

  // 9. Interrupt turn
  {
    name: 'codex_interrupt_turn',
    description: 'Interrupt and abort the running turn or command on an active thread.',
    schema: z.object({
      threadId: z.string().describe('The thread ID currently executing a turn.')
    }),
    handler: async (args) => {
      const success = codex.interruptTurn(args.threadId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success,
              threadId: args.threadId,
              status: success ? 'interrupted' : 'no_active_turn'
            }, null, 2)
          }
        ]
      };
    },
  },
  {
    name: 'codex_interrupt',
    description: 'Alias for codex_interrupt_turn. Interrupt a running turn on an active thread.',
    schema: z.object({
      threadId: z.string().describe('The thread ID currently executing a turn.')
    }),
    handler: async (args) => {
      const success = codex.interruptTurn(args.threadId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success,
              threadId: args.threadId,
              status: success ? 'interrupted' : 'no_active_turn'
            }, null, 2)
          }
        ]
      };
    }
  }
];
