import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { chatSessions } from '../db/schema.js';

/** Agent loop persists to chat_messages (FK → chat_sessions); create a real session. */
export async function ensureAgentChatSession(
  db: Db,
  hostId: string,
  title: string,
): Promise<string> {
  const id = randomUUID();
  await db.insert(chatSessions).values({
    id,
    hostId,
    title: title.slice(0, 120),
  });
  return id;
}
