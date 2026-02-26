/**
 * Demo server routes: list models, deploy from built-in BPMN files or AgenticWorkflow collection.
 * DB connection uses MONGO_URL and MONGO_DB from src/server/.env.
 */
import { Router, Request, Response } from 'express';
import multer from 'multer';
import { ObjectId } from 'mongodb';
import path from 'path';
import { readFileSync, mkdirSync, existsSync, createReadStream } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/client';
import { deployDefinition } from '../model/service';
import { startInstance, getInstance } from '../instance/service';
import { getCollections } from '../db/collections';
import { createConversation, addContextDocuments, addUserMessage } from './conversation';

export const LOCAL_MODELS = [
  { id: 'input-sequence', label: 'input-sequence — linear: input-a, input-b, input-c → calculate-results', bpmnFile: 'input-sequence.bpmn' },
  { id: 'input-sequence-with-assess', label: 'input-sequence-with-assess — input-a → assess-a → input-b → assess-b → input-c → assess-c → calculate-results', bpmnFile: 'input-sequence-with-assess.bpmn' },
  { id: 'input-sequence-with-subprocess', label: 'input-sequence-with-subprocess — input/assess a,b,c → subprocess (input-d, assess-d, input-e, assess-e) → calculate-results', bpmnFile: 'input-sequence-with-subprocess.bpmn' },
  { id: 'input-parallel-with-subprocess', label: 'input-parallel-with-subprocess — AND split: input/assess a,b,c in parallel → AND join → subprocess → calculate-results', bpmnFile: 'input-parallel-with-subprocess.bpmn' },
];

export type ModelSource = 'local' | 'insight';

function getBpmnPath(bpmnFile: string): string {
  const serverDir = __dirname;
  const projectRoot = path.resolve(serverDir, '..', '..');
  return path.join(projectRoot, 'test', 'bpmn', bpmnFile);
}

function getDataDir(): string {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const dataDir = path.join(projectRoot, 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, getDataDir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${uuidv4().slice(0, 8)}-${base}${ext}`);
    },
  }),
});

const AGENTIC_WORKFLOW_COLLECTION = 'AgenticWorkflow';

export const serverRouter = Router();

/** Upload files to data/, return [{ filename, path }]. Path is stored filename (e.g. "abc12345-report.pdf"). */
serverRouter.post('/demo/upload', upload.array('files', 20), (req: Request, res: Response) => {
  try {
    const files = (req.files as Express.Multer.File[]) ?? [];
    const items = files.map((f) => ({
      filename: f.originalname,
      path: f.filename,
    }));
    res.json({ documents: items });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Upload failed';
    res.status(500).json({ error: msg });
  }
});

/** Serve a document from data/ by path. Path is the stored filename (no slashes). */
serverRouter.get('/demo/documents/:path', (req: Request, res: Response) => {
  const raw = req.params.path;
  const basename = path.basename(raw);
  if (!basename || basename.includes('..') || basename.includes(path.sep)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  const dataDir = getDataDir();
  const fullPath = path.resolve(dataDir, basename);
  const dataDirResolved = path.resolve(dataDir);
  if (!fullPath.startsWith(dataDirResolved + path.sep) && fullPath !== dataDirResolved) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  if (!existsSync(fullPath)) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  res.setHeader('Content-Disposition', `inline; filename="${basename}"`);
  createReadStream(fullPath).pipe(res);
});

serverRouter.get('/demo/models', async (req: Request, res: Response) => {
  try {
    const source = (req.query.source as string) || 'insight';
    const provider = (req.query.provider as string) ?? '';
    if (source === 'insight') {
      const db = getDb();
      const col = db.collection(AGENTIC_WORKFLOW_COLLECTION);
      const filter: Record<string, unknown> = {};
      const p = provider.trim();
      if (p) filter.provider = p;
      const docs = await col.find(filter, { projection: { _id: 1, name: 1 } }).toArray();
      const models = docs.map((d) => ({
        id: String(d._id),
        label: d.name ?? String(d._id),
      }));
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.json({ models, source: 'insight' });
    } else {
      const models = LOCAL_MODELS.map((m) => ({ id: m.id, label: m.label }));
      res.json({ models, source: 'local' });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'List failed';
    res.status(500).json({ error: msg });
  }
});

serverRouter.post('/demo/deploy', async (req: Request, res: Response) => {
  try {
    const { modelId, source } = req.body as { modelId: string; source?: ModelSource };
    const effectiveSource = source ?? 'local';
    let bpmnXml: string;
    let deployName: string;
    let deployId: string;

    if (effectiveSource === 'insight') {
      const db = getDb();
      const col = db.collection(AGENTIC_WORKFLOW_COLLECTION);
      const idFilter = ObjectId.isValid(modelId) ? { _id: new ObjectId(modelId) } : { name: modelId };
      const doc = await col.findOne(idFilter);
      if (!doc?.bpmnXML) {
        res.status(404).json({ error: 'Workflow not found in AgenticWorkflow or missing bpmnXML' });
        return;
      }
      bpmnXml = doc.bpmnXML as string;
      deployName = (doc as { name?: string }).name ?? String(doc._id);
      deployId = String(doc._id);
    } else {
      const model = LOCAL_MODELS.find((m) => m.id === modelId);
      if (!model) {
        res.status(400).json({ error: 'Unknown model' });
        return;
      }
      bpmnXml = readFileSync(getBpmnPath(model.bpmnFile), 'utf8');
      deployName = model.id;
      deployId = modelId;
    }

    const db = getDb();
    const deployed = await deployDefinition(db, {
      id: deployId,
      name: deployName,
      version: '1',
      bpmnXml,
      overwrite: true,
    });
    res.json({ definitionId: deployed.definitionId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Deploy failed';
    res.status(400).json({ error: msg });
  }
});

serverRouter.post('/demo/start', async (req: Request, res: Response) => {
  try {
    const { definitionId, user, contextDocuments } = req.body as {
      definitionId: string;
      user?: { email: string };
      contextDocuments?: Array<{ filename: string; path: string }>;
    };
    if (!definitionId) {
      res.status(400).json({ error: 'definitionId required' });
      return;
    }
    const db = getDb();
    const userEmail = user?.email ?? 'ui-user@example.com';
    const conversationId = await createConversation(db, {
      user: userEmail,
      contextDocuments: contextDocuments ?? [],
    });
    await addUserMessage(db, conversationId, 'Started process');
    const result = await startInstance(db, {
      commandId: uuidv4(),
      definitionId,
      conversationId,
      user: { email: userEmail },
    });
    res.status(201).json({ ...result, conversationId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Start failed';
    res.status(400).json({ error: msg });
  }
});

serverRouter.get('/demo/conversations/:conversationId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { getConversation } = await import('./conversation');
    const conv = await getConversation(db, req.params.conversationId);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json(conv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Get failed';
    res.status(500).json({ error: msg });
  }
});

serverRouter.post('/demo/tasks/:taskId/complete', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const { commandId, userId, result: taskResult, contextDocuments } = req.body as {
      commandId: string;
      userId: string;
      result?: unknown;
      contextDocuments?: Array<{ filename: string; path: string }>;
    };
    if (!commandId || !userId) {
      res.status(400).json({ error: 'commandId and userId required' });
      return;
    }
    const db = getDb();
    const cols = getCollections(db);
    const { HumanTasks } = cols;
    const task = await HumanTasks.findOne({ _id: taskId });
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (task.status !== 'OPEN' && task.status !== 'CLAIMED') {
      res.status(409).json({ error: 'Task already completed or canceled' });
      return;
    }
    if (task.status === 'CLAIMED' && task.assigneeUserId !== userId) {
      res.status(403).json({ error: 'Task claimed by another user' });
      return;
    }
    const instance = await getInstance(db, task.instanceId);
    if (instance?.conversationId) {
      if (contextDocuments?.length) {
        await addContextDocuments(db, instance.conversationId, contextDocuments);
      }
      const userContent =
        typeof taskResult === 'object' && taskResult != null && 'value' in taskResult
          ? String((taskResult as { value?: unknown }).value ?? JSON.stringify(taskResult))
          : JSON.stringify(taskResult ?? '');
      if (userContent) await addUserMessage(db, instance.conversationId, userContent);
    }
    const { Continuations } = cols;
    const now = new Date();
    await Continuations.insertOne({
      _id: uuidv4(),
      instanceId: task.instanceId,
      dueAt: now,
      kind: 'WORK_COMPLETED',
      payload: { workItemId: taskId, commandId, result: taskResult },
      status: 'READY',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    res.status(202).json({ accepted: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Complete failed';
    res.status(400).json({ error: msg });
  }
});
