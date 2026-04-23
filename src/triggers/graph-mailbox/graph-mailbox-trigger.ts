/**
 * Microsoft 365 mailbox trigger. Polls a mailbox via Graph API and emits
 * one StartRequest per unread email. The message id is the dedup key, so
 * retries and restarts collapse to a single process instance per email.
 *
 * The plugin owns its credentials: per-schedule overrides via
 * TriggerSchedule.credentials, env-var fallback via GRAPH_* variables.
 * Engine core has no knowledge of Graph / Azure AD.
 *
 * The pre-refactor worker awaited a host-provided `onMailReceived` callback
 * between instance creation and START continuation insertion, so the host
 * could stash attachments / seed data-pools before BPMN execution began.
 * The new trigger preserves that hook via `setOnMailReceived`; if no
 * callback is set, instances are started immediately.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import {
  pollMailbox,
  markAsRead,
  listAttachments,
  getAttachmentContent,
  DEFAULT_GRAPH_POLLING_INTERVAL_MS,
  type GraphCredentials,
  type GraphEmail,
} from './graph';
import { startInstance, insertStartContinuation } from '../../instance/service';
import { getCollections } from '../../db/collections';
import { stripTriPrefix } from '../attrs';
import type {
  BpmnClaim,
  BpmnStartEventView,
  StartTrigger,
  TriggerCursor,
  TriggerDefinition,
  TriggerInvocation,
  TriggerResult,
  TriggerSchedule,
} from '../types';

export const GRAPH_MAILBOX_TRIGGER_TYPE = 'graph-mailbox';

export type MailReceivedEvent = {
  mailbox: string;
  instanceId: string;
  definitionId: string;
  email: {
    id: string;
    subject: string;
    from: { name?: string; address: string };
    toRecipients: Array<{ name?: string; address: string }>;
    receivedDateTime: string;
    bodyPreview: string;
    body: { contentType: string; content: string };
    hasAttachments: boolean;
    attachments: Array<{ id: string; name: string; contentType: string; size: number }>;
  };
  getAttachmentContent: (attachmentId: string) => Promise<Buffer>;
};

export type MailReceivedResult = { skip?: boolean } | undefined | void;

export type OnMailReceivedFn = (event: MailReceivedEvent) => Promise<MailReceivedResult>;

function extractCredentials(
  creds: Record<string, unknown> | null,
): GraphCredentials | undefined {
  if (!creds) return undefined;
  const tenantId = typeof creds.tenantId === 'string' ? creds.tenantId : undefined;
  const clientId = typeof creds.clientId === 'string' ? creds.clientId : undefined;
  const clientSecret = typeof creds.clientSecret === 'string' ? creds.clientSecret : undefined;
  if (!tenantId && !clientId && !clientSecret) return undefined;
  return { tenantId, clientId, clientSecret };
}

function toMailEvent(
  mailbox: string,
  email: GraphEmail,
  instanceId: string,
  definitionId: string,
  attachmentMeta: Array<{ id: string; name: string; contentType: string; size: number }>,
  credentials?: GraphCredentials,
): MailReceivedEvent {
  return {
    mailbox,
    instanceId,
    definitionId,
    email: {
      id: email.id,
      subject: email.subject,
      from: email.from.emailAddress,
      toRecipients: email.toRecipients.map((r) => r.emailAddress),
      receivedDateTime: email.receivedDateTime,
      bodyPreview: email.bodyPreview,
      body: email.body,
      hasAttachments: email.hasAttachments,
      attachments: attachmentMeta,
    },
    getAttachmentContent: (attachmentId: string) =>
      getAttachmentContent(mailbox, email.id, attachmentId, credentials),
  };
}

export class GraphMailboxTrigger implements StartTrigger {
  readonly triggerType = GRAPH_MAILBOX_TRIGGER_TYPE;
  readonly defaultInitialPolicy = 'fire-existing' as const;

  private onMailReceived: OnMailReceivedFn | null = null;
  private readonly defaultPollingIntervalMs: number;

  constructor(options?: {
    onMailReceived?: OnMailReceivedFn;
    defaultPollingIntervalMs?: number;
  }) {
    this.onMailReceived = options?.onMailReceived ?? null;
    this.defaultPollingIntervalMs =
      options?.defaultPollingIntervalMs ?? DEFAULT_GRAPH_POLLING_INTERVAL_MS;
  }

  /**
   * Configure the onMailReceived hook after construction — used when the
   * engine client registers its default trigger and the host later calls
   * `init({ onMailReceived })`.
   */
  setOnMailReceived(fn: OnMailReceivedFn | null): void {
    this.onMailReceived = fn;
  }

  claimFromBpmn(event: BpmnStartEventView): BpmnClaim | null {
    const ct = event.messageAttrs?.['tri:connectorType'];
    if (ct !== GRAPH_MAILBOX_TRIGGER_TYPE) return null;
    return { config: stripTriPrefix(event.messageAttrs!, ['connectorType']) };
  }

  validate(def: TriggerDefinition): void {
    const mailbox = def.config['mailbox'];
    if (typeof mailbox !== 'string' || mailbox.length === 0) {
      throw new Error('graph-mailbox trigger requires tri:mailbox on the <bpmn:message>');
    }
  }

  nextSchedule(
    def: TriggerDefinition,
    _lastFiredAt: Date | null,
    _cursor: TriggerCursor,
  ): TriggerSchedule {
    const explicit = Number(def.config['pollingIntervalMs']);
    const ms = Number.isFinite(explicit) && explicit > 0 ? explicit : this.defaultPollingIntervalMs;
    return { kind: 'interval', ms };
  }

  async fire(invocation: TriggerInvocation): Promise<TriggerResult> {
    const mailbox = String(invocation.definition.config['mailbox'] ?? '');
    if (!mailbox) {
      throw new Error('graph-mailbox trigger missing mailbox in config');
    }

    const creds = extractCredentials(invocation.credentials);
    const emails = await pollMailbox(mailbox, { credentials: creds });

    invocation.report?.observed(emails.length);
    if (emails.length === 0) {
      return { starts: [], nextCursor: invocation.cursor };
    }

    // The handler hook runs outside the scheduler's transaction — it may
    // download attachments and do other work that can't sit inside a Mongo
    // session. We still need exactly-once instance creation, so we start
    // each instance here (before returning to the scheduler), guarded by
    // the per-email idempotency key. The scheduler's result atomicity only
    // applies to cursor advance in this case.
    const { ProcessInstances } = getCollections(invocation.db);

    for (const email of emails) {
      const idempotencyKey = `${invocation.scheduleId}:${email.id}`;
      const existing = await ProcessInstances.findOne(
        { definitionId: invocation.definition.definitionId, idempotencyKey },
        { projection: { _id: 1 } },
      );
      if (existing) {
        // Already processed in a prior (possibly crashed) fire — just
        // mark as read and move on.
        invocation.report?.dropped('already-processed');
        await markAsRead(mailbox, email.id, creds);
        continue;
      }

      const commandId = uuidv4();
      const { instanceId } = await startInstance(invocation.db, {
        commandId,
        definitionId: invocation.definition.definitionId,
        businessKey: `email:${email.id}`,
        idempotencyKey,
        tenantId: invocation.startingTenantId,
        deferContinuation: true,
      });

      let attachmentMeta: Array<{ id: string; name: string; contentType: string; size: number }> = [];
      if (email.hasAttachments) {
        try {
          attachmentMeta = await listAttachments(mailbox, email.id, creds);
        } catch (err) {
          console.error(`[graph-mailbox] Failed to list attachments for ${email.id}:`, err);
        }
      }

      let skip = false;
      let callbackErr: unknown = null;
      if (this.onMailReceived) {
        try {
          const r = await this.onMailReceived(
            toMailEvent(
              mailbox,
              email,
              instanceId,
              invocation.definition.definitionId,
              attachmentMeta,
              creds,
            ),
          );
          if (r?.skip) skip = true;
        } catch (err) {
          console.error(`[graph-mailbox] onMailReceived threw for ${email.id}:`, err);
          skip = true;
          callbackErr = err;
        }
      }

      if (skip) {
        await terminateInstance(invocation.db, instanceId);
        if (callbackErr) {
          const msg = callbackErr instanceof Error ? callbackErr.message : String(callbackErr);
          const stack = callbackErr instanceof Error ? callbackErr.stack : undefined;
          invocation.report?.error({
            stage: 'callback',
            message: msg,
            rawSnippet: stack ? stack.slice(0, 500) : undefined,
          });
        } else {
          invocation.report?.dropped('callback-skip');
        }
      } else {
        await insertStartContinuation(invocation.db, { instanceId, commandId });
        invocation.report?.fired(instanceId);
      }

      await markAsRead(mailbox, email.id, creds);
    }

    // The trigger reports no starts to the scheduler because instance
    // creation already happened above (idempotently). All we need the
    // scheduler to do is clear our lease and carry forward the cursor.
    return { starts: [], nextCursor: invocation.cursor };
  }
}

async function terminateInstance(db: Db, instanceId: string): Promise<void> {
  const { ProcessInstances, ProcessInstanceState } = getCollections(db);
  const now = new Date();
  await ProcessInstances.updateOne(
    { _id: instanceId },
    { $set: { status: 'TERMINATED', endedAt: now } },
  );
  await ProcessInstanceState.updateOne(
    { _id: instanceId },
    { $set: { status: 'TERMINATED' } },
  );
}
