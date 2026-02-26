require('dotenv').config();
process.env.MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017';
process.env.MONGO_DB = process.env.MONGO_DB ?? 'BPM';

import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';
import { join } from 'path';
import { connectDb, closeDb, getDb } from '../src/db/client';
import { ensureIndexes } from '../src/db/indexes';
import { getCollections } from '../src/db/collections';
import { deployDefinition } from '../src/model/service';
import { startInstance } from '../src/instance/service';
import { claimContinuation, processContinuation } from '../src/workers/processor';

async function run() {
  const db = await connectDb();
  await db.dropDatabase();
  await ensureIndexes(db);

  const bpmn = readFileSync(
    join(__dirname, '../test/bpmn/start-service-task-end.bpmn'),
    'utf-8'
  );

  const { definitionId } = await deployDefinition(db, { id: 'test-integration', name: 'Test', version: '1', bpmnXml: bpmn });
  console.log('Deployed:', definitionId);

  const { instanceId } = await startInstance(db, {
    commandId: 'cmd-1',
    definitionId,
  });
  console.log('Started instance:', instanceId);

  for (let i = 0; i < 10; i++) {
    const cont = await claimContinuation(db);
    if (!cont) break;
    console.log('Processing:', cont.kind, cont.payload);
    await processContinuation(db, cont);
  }

  const { ProcessInstanceState } = getCollections(db);
  const state = await ProcessInstanceState.findOne({ _id: instanceId });
  console.log('State:', JSON.stringify(state, null, 2));

  const workItem = state?.waits?.workItems?.[0];
  if (workItem) {
    const { Continuations } = getCollections(db);
    await Continuations.insertOne({
      _id: uuidv4(),
      instanceId,
      dueAt: new Date(),
      kind: 'WORK_COMPLETED',
      payload: { workItemId: workItem.workItemId, commandId: 'cmd-2' },
      status: 'READY',
      attempts: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    for (let i = 0; i < 5; i++) {
      const cont = await claimContinuation(db);
      if (!cont) break;
      console.log('Processing:', cont.kind, cont.payload);
      await processContinuation(db, cont);
    }

    const state2 = await ProcessInstanceState.findOne({ _id: instanceId });
    console.log('Final state:', JSON.stringify(state2, null, 2));
  }

  await closeDb();
  console.log('Done');
}

run().catch(console.error);
