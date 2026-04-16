/**
 * Demo server routes: list models, deploy from built-in BPMN files or AgenticWorkflow collection.
 * AgenticWorkflow lives in MONGO_DB; BPM definitions/instances in MONGO_BPM_DB.
 */
import { Router, Request, Response } from 'express';
import { config } from '../config';
import multer from 'multer';
import { ObjectId } from 'mongodb';
import path from 'path';
import { readFileSync, mkdirSync, existsSync, createReadStream } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getDb, getConversationsDb } from '../db/client';
import { deployDefinition } from '../model/service';
import { startInstance, getInstance } from '../instance/service';
import { getCollections } from '../db/collections';
import { createConversation, addContextDocuments, addUserMessage, ingestProcessInstance } from './conversation';
import { extractRolesFromBpmn } from '../model/validator';
import { getUserFromAuthHeader } from './jwt';

export const LOCAL_MODELS = [
  { id: 'neo-watch', label: 'NEO Watch — NASA asteroid hazard: fetch NEO data → XOR gateway → astronomer review → file alert', bpmnFile: 'neo-watch.bpmn' },
  { id: 'input-sequence', label: 'input-sequence — linear: input-a, input-b, input-c → calculate-results', bpmnFile: 'input-sequence.bpmn' },
  { id: 'input-sequence-with-assess', label: 'input-sequence-with-assess — input-a → assess-a → input-b → assess-b → input-c → assess-c → calculate-results', bpmnFile: 'input-sequence-with-assess.bpmn' },
  { id: 'input-sequence-with-subprocess', label: 'input-sequence-with-subprocess — input/assess a,b,c → subprocess (input-d, assess-d, input-e, assess-e) → calculate-results', bpmnFile: 'input-sequence-with-subprocess.bpmn' },
  { id: 'input-parallel-with-subprocess', label: 'input-parallel-with-subprocess — AND split: input/assess a,b,c in parallel → AND join → subprocess → calculate-results', bpmnFile: 'input-parallel-with-subprocess.bpmn' },
  { id: 'linear-service-and-user-task-with-roles', label: 'linear-with-roles — FrontOffice → BackOffice → Accounting (tri:roleId on lanes)', bpmnFile: 'linear-service-and-user-task-with-roles.bpmn' },
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

/** Portal feature flags — consumed by app.js on startup. */
serverRouter.get('/demo/config', (_req: Request, res: Response) => {
  res.json({ triTesting: config.triTesting });
});

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
      const insightDb = getConversationsDb();
      const col = insightDb.collection(AGENTIC_WORKFLOW_COLLECTION);
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

/**
 * Inject a timerEventDefinition into the first <bpmn:startEvent> in the XML.
 * Used by the portal's "Schedule..." button to add a timer cycle to any process.
 */
function injectTimerCycle(bpmnXml: string, timerCycle: string): string {
  // Escape XML special chars in the expression
  const escaped = timerCycle.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const timerDef = `<bpmn:timerEventDefinition><bpmn:timeCycle>${escaped}</bpmn:timeCycle></bpmn:timerEventDefinition>`;

  // Replace self-closing startEvent: <bpmn:startEvent id="..."/>
  const selfClose = /(<bpmn:startEvent\s[^>]*?)\s*\/>/;
  if (selfClose.test(bpmnXml)) {
    return bpmnXml.replace(selfClose, `$1>${timerDef}</bpmn:startEvent>`);
  }
  // Replace open startEvent: <bpmn:startEvent id="...">...</bpmn:startEvent>
  const openTag = /(<bpmn:startEvent\s[^>]*?>)/;
  if (openTag.test(bpmnXml)) {
    return bpmnXml.replace(openTag, `$1${timerDef}`);
  }
  return bpmnXml;
}

serverRouter.post('/demo/deploy', async (req: Request, res: Response) => {
  try {
    const { modelId, source, timerCycle } = req.body as { modelId: string; source?: ModelSource; timerCycle?: string };
    const effectiveSource = source ?? 'local';
    let bpmnXml: string;
    let deployName: string;
    let deployId: string;

    if (effectiveSource === 'insight') {
      const insightDb = getConversationsDb();
      const col = insightDb.collection(AGENTIC_WORKFLOW_COLLECTION);
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

    if (timerCycle) {
      bpmnXml = injectTimerCycle(bpmnXml, timerCycle);
    }

    const db = getDb();
    const deployed = await deployDefinition(db, {
      id: deployId,
      name: deployName,
      version: '1',
      bpmnXml,
      overwrite: true,
    });
    const roles = extractRolesFromBpmn(bpmnXml);
    res.json({ definitionId: deployed.definitionId, roles });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Deploy failed';
    res.status(400).json({ error: msg });
  }
});

serverRouter.post('/demo/start', async (req: Request, res: Response) => {
  try {
    const { definitionId, user, contextDocuments } = req.body as {
      definitionId: string;
      user?: { email?: string; firstName?: string; lastName?: string };
      contextDocuments?: Array<{ filename: string; path: string }>;
    };
    if (!definitionId) {
      res.status(400).json({ error: 'definitionId required' });
      return;
    }
    const db = getDb();
    const convDb = getConversationsDb();
    const userEmail = user?.email ?? 'ada@the-real-insight.com';
    const userFromJwt = getUserFromAuthHeader(req.headers.authorization);
    const effectiveUser = user && (user.firstName || user.lastName)
      ? user
      : userFromJwt
        ? { email: userEmail, firstName: userFromJwt.firstName, lastName: userFromJwt.lastName }
        : { email: userEmail };
    const conversationId = await createConversation(convDb, {
      user: userEmail,
      contextDocuments: contextDocuments ?? [],
    });
    const { ProcessDefinitions } = getCollections(db);
    const def = await ProcessDefinitions.findOne(
      { _id: definitionId },
      { projection: { name: 1 } }
    );
    const processName = (def as { name?: string } | null)?.name ?? 'process';
    const timestamp = new Date().toLocaleString().replace(/[.,]/g, '');
    await addUserMessage(convDb, conversationId, `${processName} ${timestamp}`, {
      email: effectiveUser.email ?? userEmail,
      firstName: effectiveUser.firstName,
      lastName: effectiveUser.lastName,
    });
    const result = await startInstance(db, {
      commandId: uuidv4(),
      definitionId,
      conversationId,
      user: { email: userEmail, firstName: effectiveUser.firstName, lastName: effectiveUser.lastName },
    });
    await ingestProcessInstance(convDb, conversationId, result.instanceId);
    res.status(201).json({ ...result, conversationId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Start failed';
    res.status(400).json({ error: msg });
  }
});

serverRouter.get('/demo/conversations/:conversationId', async (req: Request, res: Response) => {
  try {
    const convDb = getConversationsDb();
    const { getConversation } = await import('./conversation');
    const conv = await getConversation(convDb, req.params.conversationId);
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
    const { commandId, userId, user: userDetails, result: taskResult, contextDocuments } = req.body as {
      commandId: string;
      userId: string;
      user?: { email?: string; firstName?: string; lastName?: string };
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
      const convDb = getConversationsDb();
      if (contextDocuments?.length) {
        await addContextDocuments(convDb, instance.conversationId, contextDocuments);
      }
      const userContent =
        typeof taskResult === 'object' && taskResult != null && 'value' in taskResult
          ? String((taskResult as { value?: unknown }).value ?? JSON.stringify(taskResult))
          : JSON.stringify(taskResult ?? '');
      if (userContent) {
        const userForMessage =
          userDetails && (userDetails.firstName || userDetails.lastName || userDetails.email)
            ? { email: userId, firstName: userDetails.firstName, lastName: userDetails.lastName }
            : getUserFromAuthHeader(req.headers.authorization) ?? { email: userId };
        await addUserMessage(convDb, instance.conversationId, userContent, userForMessage);
      }
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
