/**
 * Conversation management for document/data context.
 * Uses tri-model Conversation shape; stored in Conversation collection.
 * Conversation _id uses MongoDB ObjectId for consistency with tri-server.
 */
import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import {
  type Conversation as TriConversation,
  type ContextDocument,
  MessageType,
} from '@the-real-insight/tri-model';

/** tri-model Conversation shape for MongoDB storage. */
export type ConversationDoc = TriConversation;

const CONVERSATION_COLLECTION = 'Conversation';

/** Normalize conversationId for query: ObjectId if 24 hex chars, else string (legacy UUID). */
function toConversationIdFilter(conversationId: string): ObjectId | string {
  return /^[a-fA-F0-9]{24}$/.test(conversationId) ? new ObjectId(conversationId) : conversationId;
}

function byConversationId(conversationId: string): { _id: ObjectId | string } {
  return { _id: toConversationIdFilter(conversationId) };
}

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
  const col = db.collection<ConversationDoc>(CONVERSATION_COLLECTION);
  const id = new ObjectId();
  const doc = {
    _id: id,
    user: params.user,
    messages: [],
    contextDocuments: (params.contextDocuments ?? []).map(toContextDocument),
    created: new Date(),
    processInstance: '',
  };
  await col.insertOne(doc as unknown as ConversationDoc);
  return id.toString();
}

export async function getConversation(db: Db, conversationId: string): Promise<ConversationDoc | null> {
  const col = db.collection<ConversationDoc>(CONVERSATION_COLLECTION);
  return col.findOne(byConversationId(conversationId) as any);
}

export async function addContextDocuments(
  db: Db,
  conversationId: string,
  documents: Array<{ filename: string; path: string; summary?: string }>
): Promise<void> {
  if (documents.length === 0) return;
  const col = db.collection<ConversationDoc>(CONVERSATION_COLLECTION);
  const docsWithId = documents.map(toContextDocument);
  await col.updateOne(byConversationId(conversationId) as any, {
    $push: { contextDocuments: { $each: docsWithId } },
  });
}

export async function addUserMessage(
  db: Db,
  conversationId: string,
  content: string
): Promise<void> {
  const col = db.collection<ConversationDoc>(CONVERSATION_COLLECTION);
  const msg = { type: MessageType.userMessage, content, date: new Date(), confirmation: false, resources: [], sourceResources: [] };
  await col.updateOne(byConversationId(conversationId) as any, {
    $push: { messages: msg as any },
  });
}

export async function addBotMessage(
  db: Db,
  conversationId: string,
  content: string
): Promise<void> {
  const col = db.collection<ConversationDoc>(CONVERSATION_COLLECTION);
  const msg = { type: MessageType.botMessage, content, date: new Date(), confirmation: false, resources: [], sourceResources: [] };
  await col.updateOne(byConversationId(conversationId) as any, {
    $push: { messages: msg as any },
  });
}

/** Ingest process instance ID into Conversation (tri-model processInstance: string). */
export async function ingestProcessInstance(
  db: Db,
  conversationId: string,
  instanceId: string
): Promise<void> {
  const col = db.collection<ConversationDoc>(CONVERSATION_COLLECTION);
  await col.updateOne(byConversationId(conversationId) as any, {
    $set: { processInstance: instanceId },
  });
}
