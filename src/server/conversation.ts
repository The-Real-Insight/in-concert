/**
 * Conversation management for document/data context.
 * Uses tri-model Conversation shape; stored in Conversations collection.
 */
import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';

export type ContextDocument = {
  _id?: string;
  filename: string;
  /** Relative path under data/ (e.g. "abc123-report.pdf"). Later: S3 key. */
  path: string;
  summary?: string;
};

export type ConversationDoc = {
  _id: string;
  user: string;
  messages: unknown[];
  contextDocuments: ContextDocument[];
  created: Date;
  topic?: string;
};

const CONVERSATIONS_COLLECTION = 'Conversations';

export async function createConversation(
  db: Db,
  params: { user: string; contextDocuments?: ContextDocument[] }
): Promise<string> {
  const col = db.collection<ConversationDoc>(CONVERSATIONS_COLLECTION);
  const id = uuidv4();
  const doc: ConversationDoc = {
    _id: id,
    user: params.user,
    messages: [],
    contextDocuments: params.contextDocuments ?? [],
    created: new Date(),
  };
  await col.insertOne(doc);
  return id;
}

export async function getConversation(db: Db, conversationId: string): Promise<ConversationDoc | null> {
  const col = db.collection<ConversationDoc>(CONVERSATIONS_COLLECTION);
  return col.findOne({ _id: conversationId });
}

export async function addContextDocuments(
  db: Db,
  conversationId: string,
  documents: ContextDocument[]
): Promise<void> {
  if (documents.length === 0) return;
  const col = db.collection<ConversationDoc>(CONVERSATIONS_COLLECTION);
  const docsWithId = documents.map((d) => ({ ...d, _id: d._id ?? uuidv4() }));
  await col.updateOne(
    { _id: conversationId },
    { $push: { contextDocuments: { $each: docsWithId } } }
  );
}

export type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
  at?: Date;
};

export async function addUserMessage(
  db: Db,
  conversationId: string,
  content: string
): Promise<void> {
  const col = db.collection<ConversationDoc>(CONVERSATIONS_COLLECTION);
  const msg: ConversationMessage = { role: 'user', content, at: new Date() };
  await col.updateOne({ _id: conversationId }, { $push: { messages: msg } });
}

export async function addBotMessage(
  db: Db,
  conversationId: string,
  content: string
): Promise<void> {
  const col = db.collection<ConversationDoc>(CONVERSATIONS_COLLECTION);
  const msg: ConversationMessage = { role: 'assistant', content, at: new Date() };
  await col.updateOne({ _id: conversationId }, { $push: { messages: msg } });
}
