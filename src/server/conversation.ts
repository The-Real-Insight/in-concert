/**
 * Conversation management for document/data context.
 * Uses tri-model Conversation shape; stored in Conversations collection.
 */
import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import {
  type Conversation as TriConversation,
  type ContextDocument,
  MessageType,
} from '@the-real-insight/tri-model';

/** tri-model Conversation shape for MongoDB storage. */
export type ConversationDoc = TriConversation;

const CONVERSATIONS_COLLECTION = 'Conversations';

/** Map our path-based docs to tri-model ContextDocument (markdown optional for file refs). */
function toContextDocument(d: { filename: string; path: string; summary?: string; _id?: string }) {
  return {
    _id: d._id ?? uuidv4(),
    filename: d.filename,
    markdown: '',
    path: d.path,
    summary: d.summary,
  } satisfies ContextDocument;
}

export async function createConversation(
  db: Db,
  params: { user: string; contextDocuments?: Array<{ filename: string; path: string; summary?: string }> }
): Promise<string> {
  const col = db.collection<ConversationDoc>(CONVERSATIONS_COLLECTION);
  const id = uuidv4();
  const doc = {
    _id: id,
    user: params.user,
    messages: [],
    contextDocuments: (params.contextDocuments ?? []).map(toContextDocument),
    created: new Date(),
    processInstance: '',
  };
  await col.insertOne(doc as unknown as ConversationDoc);
  return id;
}

export async function getConversation(db: Db, conversationId: string): Promise<ConversationDoc | null> {
  const col = db.collection<ConversationDoc>(CONVERSATIONS_COLLECTION);
  return col.findOne({ _id: conversationId });
}

export async function addContextDocuments(
  db: Db,
  conversationId: string,
  documents: Array<{ filename: string; path: string; summary?: string }>
): Promise<void> {
  if (documents.length === 0) return;
  const col = db.collection<ConversationDoc>(CONVERSATIONS_COLLECTION);
  const docsWithId = documents.map(toContextDocument);
  await col.updateOne(
    { _id: conversationId },
    { $push: { contextDocuments: { $each: docsWithId } } }
  );
}

export async function addUserMessage(
  db: Db,
  conversationId: string,
  content: string
): Promise<void> {
  const col = db.collection<ConversationDoc>(CONVERSATIONS_COLLECTION);
  const msg = { type: MessageType.userMessage, content, date: new Date(), confirmation: false, resources: [], sourceResources: [] };
  await col.updateOne(
    { _id: conversationId },
    { $push: { messages: msg as any } }
  );
}

export async function addBotMessage(
  db: Db,
  conversationId: string,
  content: string
): Promise<void> {
  const col = db.collection<ConversationDoc>(CONVERSATIONS_COLLECTION);
  const msg = { type: MessageType.botMessage, content, date: new Date(), confirmation: false, resources: [], sourceResources: [] };
  await col.updateOne(
    { _id: conversationId },
    { $push: { messages: msg as any } }
  );
}

/** Ingest process instance ID into Conversation (tri-model processInstance: string). */
export async function ingestProcessInstance(
  db: Db,
  conversationId: string,
  instanceId: string
): Promise<void> {
  const col = db.collection<ConversationDoc>(CONVERSATIONS_COLLECTION);
  await col.updateOne(
    { _id: conversationId },
    { $set: { processInstance: instanceId } }
  );
}
