/**
 * Worklist tests: role-based filtering via userId and roleIds (from user.roleAssignments).
 */
import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { BpmnEngineClient } from '../../src/sdk/client';
import {
  setupDb,
  teardownDb,
  shouldPurgeDb,
  loadBpmn,
  getWorklistTasks,
  activateWorklistTask,
  MOCK_USER,
} from '../scripts/helpers';
import { ensureIndexes } from '../../src/db/indexes';
import { addStreamHandler } from '../../src/ws/broadcast';
import { createProjectionHandler } from '../../src/worklist/projection';

jest.setTimeout(20000);

let db: Db;
let client: BpmnEngineClient;
let unsubscribeProjection: (() => void) | null = null;

beforeAll(async () => {
  db = await setupDb();
  await ensureIndexes(db);
  client = new BpmnEngineClient({ mode: 'local', db });
  unsubscribeProjection = addStreamHandler(createProjectionHandler(db));

  client.init({
    onWorkItem: async (item) => {
      // Do not auto-complete; leave tasks OPEN for worklist tests
      if ((item.payload as { kind?: string }).kind === 'serviceTask') {
        await client.completeExternalTask(item.instanceId, item.payload.workItemId);
      }
    },
    onServiceCall: async (item) => {
      await client.completeExternalTask(item.instanceId, item.payload.workItemId);
    },
  });
  client.startEngineWorker();
});

afterAll(async () => {
  await client.stopEngineWorker();
  unsubscribeProjection?.();
  await teardownDb();
});

beforeEach(async () => {
  if (shouldPurgeDb()) {
    await db.dropDatabase();
    await ensureIndexes(db);
  }
});

function uniqueName(base: string) {
  return `${base}_${uuidv4().slice(0, 8)}`;
}

describe('Worklist role filter', () => {
  it('stores roleId and candidateRoleIds on HumanTask when BPMN has tri:roleId', async () => {
    const bpmn = loadBpmn('linear-service-and-user-task-with-roles.bpmn');
    const name = uniqueName('RoleFilter');
    const { definitionId } = await client.deploy({
      id: name,
      name,
      version: '1',
      bpmnXml: bpmn,
    });
    const { instanceId } = await client.startInstance({
      commandId: uuidv4(),
      definitionId,
      user: MOCK_USER,
    });

    await client.run(instanceId);

    const openTasks = await getWorklistTasks(db, { status: 'OPEN' });
    const enterTask = openTasks.find((t) => t.name === 'EnterCaseData' && t.instanceId === instanceId);
    expect(enterTask).toBeDefined();
    expect(enterTask!.role).toBe('FrontOffice');
    expect(enterTask!.roleId).toBe('role-frontoffice');
    expect(enterTask!.candidateRoleIds).toContain('role-frontoffice');
  });

  it('getWorklistForUser returns OPEN tasks matching user roleIds', async () => {
    const bpmn = loadBpmn('linear-service-and-user-task-with-roles.bpmn');
    const name = uniqueName('WorklistForUser');
    const { definitionId } = await client.deploy({
      id: name,
      name,
      version: '1',
      bpmnXml: bpmn,
    });
    const { instanceId } = await client.startInstance({
      commandId: uuidv4(),
      definitionId,
      user: MOCK_USER,
    });

    await client.run(instanceId);

    const userId = '689eeac425b1953d449b63c0';
    const roleIds = ['role-frontoffice', 'role-accounting'];

    const tasks = await client.getWorklistForUser({ userId, roleIds });
    const enterTask = tasks.find((t) => t.name === 'EnterCaseData' && t.instanceId === instanceId);
    expect(enterTask).toBeDefined();
    expect(enterTask!.roleId).toBe('role-frontoffice');
  });

  it('getWorklistForUser returns CLAIMED tasks for assigneeUserId', async () => {
    const bpmn = loadBpmn('linear-service-and-user-task-with-roles.bpmn');
    const name = uniqueName('ClaimedWorklist');
    const { definitionId } = await client.deploy({
      id: name,
      name,
      version: '1',
      bpmnXml: bpmn,
    });
    const { instanceId } = await client.startInstance({
      commandId: uuidv4(),
      definitionId,
      user: MOCK_USER,
    });

    await client.run(instanceId);

    const openTasks = await getWorklistTasks(db, { status: 'OPEN' });
    const enterTask = openTasks.find((t) => t.name === 'EnterCaseData' && t.instanceId === instanceId);
    expect(enterTask).toBeDefined();

    const userId = '689eeac425b1953d449b63c0';
    await activateWorklistTask(db, enterTask!._id, userId);

    const tasks = await client.getWorklistForUser({
      userId,
      roleIds: ['role-frontoffice', 'role-backoffice'],
    });
    const claimedTask = tasks.find((t) => t._id === enterTask!._id);
    expect(claimedTask).toBeDefined();
    expect(claimedTask!.status).toBe('CLAIMED');
    expect(claimedTask!.assigneeUserId).toBe(userId);
  });

  it('getWorklistForUser excludes OPEN tasks when user has no matching role', async () => {
    const bpmn = loadBpmn('linear-service-and-user-task-with-roles.bpmn');
    const name = uniqueName('NoRoleMatch');
    const { definitionId } = await client.deploy({
      id: name,
      name,
      version: '1',
      bpmnXml: bpmn,
    });
    const { instanceId } = await client.startInstance({
      commandId: uuidv4(),
      definitionId,
      user: MOCK_USER,
    });

    await client.run(instanceId);

    const userId = '689eeac425b1953d449b63c0';
    const roleIds = ['role-other']; // User has no FrontOffice/BackOffice/Accounting role

    const tasks = await client.getWorklistForUser({ userId, roleIds });
    const enterTask = tasks.find((t) => t.name === 'EnterCaseData' && t.instanceId === instanceId);
    expect(enterTask).toBeUndefined();
  });
});
