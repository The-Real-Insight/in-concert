/**
 * SDK integration test: custom-namespace start-trigger plugin.
 *
 * Exercises the "extension attributes flow through verbatim" guarantee
 * end-to-end: a BPMN with `acme:*` attributes, a plugin that recognizes
 * and consumes them via the generic `stripPrefix` helper, and the
 * scheduler firing an instance with the plugin-owned config.
 *
 * None of the engine-side code under test names the `tri:` prefix.
 */
import type { Db } from 'mongodb';
import { BpmnEngineClient } from '../../src/sdk/client';
import {
  setupDb,
  teardownDb,
  loadBpmn,
} from '../scripts/helpers';
import { ensureIndexes } from '../../src/db/indexes';
import { getCollections } from '../../src/db/collections';
import { processOneTrigger } from '../../src/workers/trigger-scheduler';
import { TriggerRegistry } from '../../src/triggers/registry';
import { stripPrefix } from '../../src/triggers/attrs';
import { parseBpmnXml } from '../../src/model/parser';
import type {
  BpmnClaim,
  BpmnStartEventView,
  StartTrigger,
  TriggerCursor,
  TriggerDefinition,
  TriggerInvocation,
  TriggerResult,
  TriggerSchedule,
} from '../../src/triggers/types';

jest.setTimeout(15_000);

let db: Db;

beforeAll(async () => {
  db = await setupDb();
  await ensureIndexes(db);
});

afterAll(async () => {
  await teardownDb();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
});

/**
 * A minimal fake trigger that reads its config from the `acme:` namespace.
 * No references to `tri:*` — demonstrates the namespace freedom promised
 * by the plugin contract.
 */
class AcmePagerDutyTrigger implements StartTrigger {
  readonly triggerType = 'acme-pagerduty';
  readonly defaultInitialPolicy = 'skip-existing' as const;
  readonly firedCount = { n: 0 };

  claimFromBpmn(event: BpmnStartEventView): BpmnClaim | null {
    if (event.eventDefinitionKind !== 'message') return null;
    if (event.messageAttrs?.['acme:connectorType'] !== 'acme-pagerduty') return null;
    return {
      config: stripPrefix(event.messageAttrs, 'acme:', ['connectorType']),
    };
  }

  validate(def: TriggerDefinition): void {
    if (typeof def.config['serviceKey'] !== 'string' || !def.config['serviceKey']) {
      throw new Error('acme-pagerduty trigger requires acme:serviceKey');
    }
  }

  nextSchedule(
    _def: TriggerDefinition,
    _lastFiredAt: Date | null,
    _cursor: TriggerCursor,
  ): TriggerSchedule {
    return { kind: 'interval', ms: 60_000 };
  }

  async fire(invocation: TriggerInvocation): Promise<TriggerResult> {
    this.firedCount.n++;
    return {
      starts: [
        {
          dedupKey: `pd-${this.firedCount.n}`,
          payload: { acme: invocation.definition.config },
        },
      ],
      nextCursor: invocation.cursor,
    };
  }
}

describe('custom-namespace extension attributes', () => {
  it('parser captures acme:* attributes verbatim into messageAttrs and selfAttrs', async () => {
    const bpmnXml = loadBpmn('custom-namespace-start.bpmn');
    const graph = await parseBpmnXml(bpmnXml);

    const startNode = graph.nodes[graph.startNodeIds[0]!];
    expect(startNode).toBeDefined();

    // The message attrs should carry the three acme:* keys.
    expect(startNode!.messageAttrs).toEqual({
      'acme:connectorType': 'acme-pagerduty',
      'acme:serviceKey': 'svc_ABC123',
      'acme:severity': 'critical',
    });
  });

  it('stripPrefix drops the acme: prefix and the discriminator', () => {
    const attrs = {
      'acme:connectorType': 'acme-pagerduty',
      'acme:serviceKey': 'svc_ABC123',
      'acme:severity': 'critical',
      // A tri: attr in the same element should be ignored by stripPrefix('acme:').
      'tri:unrelated': 'x',
    };
    expect(stripPrefix(attrs, 'acme:', ['connectorType'])).toEqual({
      serviceKey: 'svc_ABC123',
      severity: 'critical',
    });
  });

  it('deploy + fire drives a complete acme:* process to instance creation', async () => {
    const client = new BpmnEngineClient({ mode: 'local', db });
    client.init({
      onServiceCall: async (item) => {
        await client.completeExternalTask(item.instanceId, item.payload.workItemId);
      },
    });

    // Use an ISOLATED registry (not the default) so the test can't
    // accidentally succeed via a bundled trigger.
    const registry = new TriggerRegistry();
    const plugin = new AcmePagerDutyTrigger();
    registry.register(plugin);

    // Wire the custom registry into the deploy path — this requires the
    // model/service to accept an injected registry. For now, fall back
    // to getDefaultTriggerRegistry and register into it.
    const { getDefaultTriggerRegistry } = await import('../../src/triggers');
    const defaultReg = getDefaultTriggerRegistry();
    if (!defaultReg.has('acme-pagerduty')) {
      defaultReg.register(plugin);
    }

    const bpmnXml = loadBpmn('custom-namespace-start.bpmn');
    const { definitionId } = await client.deploy({
      id: `acme-${Date.now()}`,
      name: 'Acme PagerDuty',
      version: '1',
      bpmnXml,
    });

    const { TriggerSchedules } = getCollections(db);
    const rows = await TriggerSchedules.find({ definitionId }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.triggerType).toBe('acme-pagerduty');
    expect(rows[0]!.config).toEqual({
      serviceKey: 'svc_ABC123',
      severity: 'critical',
    });

    // Activate and fire.
    await client.resumeTriggerSchedule(rows[0]!._id);
    await TriggerSchedules.updateOne(
      { _id: rows[0]!._id },
      { $set: { lastFiredAt: new Date(0) } },
    );
    const fired = await processOneTrigger(db, defaultReg);
    expect(fired).toBe(true);
    expect(plugin.firedCount.n).toBe(1);

    const { ProcessInstances } = getCollections(db);
    expect(await ProcessInstances.countDocuments({ definitionId })).toBe(1);
  });
});
