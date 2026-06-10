import { listThreads, getThread } from './codex.js';

console.error('Fetching threads from Codex database...');
const threads = listThreads(5);
console.error(`Found ${threads.length} threads:`);
for (const t of threads) {
  console.error(`- ID: ${t.id}\n  Title: ${t.title}\n  CWD: ${t.cwd}\n  Updated: ${new Date(t.updatedAt * 1000).toLocaleString()}`);
}

if (threads.length > 0) {
  const details = getThread(threads[0].id);
  if (details) {
    console.error(`\nFirst thread details:\n- Title: ${details.title}\n- History length: ${details.history.length}`);
    if (details.history.length > 0) {
      console.error(`- Last message: [${details.history[details.history.length - 1].role}] ${details.history[details.history.length - 1].content.substring(0, 100)}...`);
    }
  }
}
