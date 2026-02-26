#!/usr/bin/env ts-node
/**
 * Interactive CLI demo: select a process, start it, work through the worklist.
 * No Jest - run with: npm run cli
 *
 * Models:
 *   - input-sequence: linear user tasks input-a, input-b, input-c → service task calculate-results
 */
import { createInterface } from 'readline';
import { readFileSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { connectDb, closeDb } from '../../src/db/client';
import { ensureIndexes } from '../../src/db/indexes';
import { BpmnEngineClient } from '../../src/sdk/client';
import { addStreamHandler } from '../../src/ws/broadcast';
import { createProjectionHandler } from '../../src/worklist/projection';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type HistoryEntry = Awaited<ReturnType<BpmnEngineClient['getProcessHistory']>>[number];

function renderAuditTrail(entries: HistoryEntry[]): void {
  if (entries.length === 0) return;
  console.log('\n📋 Process Audit Trail');
  console.log('─'.repeat(100));
  const col = (s: string, w: number) => String(s ?? '').padEnd(w).slice(0, w);
  const headers = ['Seq', 'Event', 'At', 'Node', 'Type', 'Started By', 'Completed By', 'Result'];
  const widths = [4, 16, 20, 28, 10, 20, 20, 24];
  console.log(headers.map((h, i) => col(h, widths[i]!)).join(' │ '));
  console.log('─'.repeat(100));
  for (const e of entries) {
    const at = e.at instanceof Date ? e.at.toISOString().slice(0, 19) : String(e.at ?? '');
    const started =
      e.eventType === 'INSTANCE_STARTED'
        ? e.startedBy ?? (e.startedByDetails as { email?: string } | undefined)?.email ?? ''
        : '';
    const completed =
      e.eventType === 'TASK_COMPLETED' ? e.completedBy ?? (e.completedByDetails as { email?: string } | undefined)?.email ?? '' : '';
    const result =
      e.eventType === 'TASK_COMPLETED' && e.result != null
        ? JSON.stringify(e.result).slice(0, 22)
        : '';
    const row = [
      col(String(e.seq), widths[0]!),
      col(e.eventType, widths[1]!),
      col(at, widths[2]!),
      col(e.nodeName ?? e.nodeId ?? '', widths[3]!),
      col(e.nodeType ?? '', widths[4]!),
      col(started, widths[5]!),
      col(completed, widths[6]!),
      col(result, widths[7]!),
    ];
    console.log(row.join(' │ '));
  }
  console.log('─'.repeat(100));
}

function robot(msg: string): void {
  console.log(`\n🤖 ${msg}`);
}

type ProcessModel = { id: string; label: string; bpmnFile: string };

const MODELS: ProcessModel[] = [
  {
    id: 'input-sequence',
    label: 'input-sequence — linear: input-a, input-b, input-c → calculate-results',
    bpmnFile: 'input-sequence.bpmn',
  },
  {
    id: 'input-sequence-with-assess',
    label: 'input-sequence-with-assess — input-a → assess-a → input-b → assess-b → input-c → assess-c → calculate-results',
    bpmnFile: 'input-sequence-with-assess.bpmn',
  },
  {
    id: 'input-sequence-with-subprocess',
    label: 'input-sequence-with-subprocess — input/assess a,b,c → subprocess (input-d, assess-d, input-e, assess-e) → calculate-results',
    bpmnFile: 'input-sequence-with-subprocess.bpmn',
  },
  {
    id: 'input-parallel-with-subprocess',
    label: 'input-parallel-with-subprocess — AND split: input/assess a,b,c in parallel → AND join → subprocess → calculate-results',
    bpmnFile: 'input-parallel-with-subprocess.bpmn',
  },
];

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log('Available process models:\n');
  MODELS.forEach((m, i) => {
    console.log(`  ${i + 1}. ${m.label}`);
  });
  console.log('');
  const raw = await prompt('Select model (1): ');
  const idx = raw ? parseInt(raw, 10) - 1 : 0;
  const model = MODELS[idx >= 0 && idx < MODELS.length ? idx : 0]!;

  robot(`Selected: ${model.id}`);

  const db = await connectDb();
  await ensureIndexes(db);
  const unsubscribeProjection = addStreamHandler(createProjectionHandler(db));

  const client = new BpmnEngineClient({ mode: 'local', db });

  let serviceTaskResult: string | null = null;
  let lastUserInput: string = '';

  client.init({
    onWorkItem: async () => {
      // Skip – handled via worklist
    },
    onServiceCall: async (item) => {
      const name = (item.payload as { name?: string }).name ?? '';
      if (name.startsWith('assess-')) {
        robot(`Assessing ${lastUserInput}`);
      } else {
        const result = Math.floor(Math.random() * 1000);
        serviceTaskResult = `The result is ${result}`;
      }
      await client.completeExternalTask(item.instanceId, item.payload.workItemId);
    },
  });

  const bpmnPath = join(__dirname, '../bpmn', model.bpmnFile);
  const bpmnXml = readFileSync(bpmnPath, 'utf8');
  const deployed = await client.deploy({
    id: model.id,
    name: model.id,
    version: '1',
    bpmnXml,
    overwrite: true,
  });
  const definitionId = deployed.definitionId;

  const user = { email: 'cli-user@example.com' };
  const { instanceId } = await client.startInstance({
    commandId: uuidv4(),
    definitionId,
    user,
  });

  robot(`Started instance: ${instanceId}`);

  const userId = user.email;

  while (true) {
    let result = await client.run(instanceId);

    if (result.status === 'COMPLETED') {
      if (serviceTaskResult) {
        robot(serviceTaskResult);
      }
      renderAuditTrail(await client.getProcessHistory(instanceId));
      unsubscribeProjection();
      await sleep(100);
      await closeDb();
      process.exit(0);
    }

    let openTasks: Awaited<ReturnType<typeof client.listTasks>> = [];
    while (openTasks.length === 0) {
      await sleep(500);
      openTasks = await client.listTasks({
        instanceId,
        status: 'OPEN',
        sortOrder: 'asc',
      });
    }

    const task = openTasks[0]!;
    const activated = await client.activateTask(task._id, { userId });
    if (!activated) {
      robot('Failed to activate task');
      continue;
    }

    robot(task.name);
    const input = await prompt('\n> ');

    lastUserInput = input;

    await client.completeUserTask(instanceId, task._id, {
      user: { email: userId },
      result: { value: input },
    });
  }
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
