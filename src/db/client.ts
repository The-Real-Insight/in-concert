import { MongoClient, Db } from 'mongodb';
import { config } from '../config';

let client: MongoClient | null = null;
let bpmDb: Db | null = null;
let conversationsDb: Db | null = null;

export async function connectDb(): Promise<Db> {
  if (bpmDb) return bpmDb;
  client = new MongoClient(config.mongoUrl);
  await client.connect();
  bpmDb = client.db(config.mongoBpmDb);
  conversationsDb = client.db(config.mongoDb);
  return bpmDb;
}

export function getClient(): MongoClient {
  if (!client) throw new Error('Database not connected');
  return client;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    bpmDb = null;
    conversationsDb = null;
  }
}

/** BPM engine data: definitions, instances, tasks, history, continuations, outbox. */
export function getDb(): Db {
  if (!bpmDb) throw new Error('Database not connected');
  return bpmDb;
}

/** Conversations only (MONGO_DB). NEVER purged. */
export function getConversationsDb(): Db {
  if (!conversationsDb) throw new Error('Database not connected');
  return conversationsDb;
}
