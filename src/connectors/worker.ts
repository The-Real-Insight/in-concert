/**
 * Connector worker: polls ConnectorSchedules, dispatches to connector-specific
 * handlers (e.g. Graph mailbox), starts process instances when events arrive.
 *
 * Same optimistic-claim pattern as the timer and continuation workers.
 */
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { getCollections, type ConnectorScheduleDoc } from '../db/collections';
import { startInstance, insertStartContinuation } from '../instance/service';
import { pollMailbox, markAsRead, listAttachments, getAttachmentContent, type GraphEmail, type GraphCredentials } from './graph';
import type { MailReceivedEvent, MailReceivedResult } from '../sdk/types';

export type OnMailReceivedFn = (event: MailReceivedEvent) => Promise<MailReceivedResult>;

/** Extract per-schedule Graph credentials if present. Returns undefined if none set. */
function extractCredentials(config: Record<string, string>): GraphCredentials | undefined {
  const { tenantId, clientId, clientSecret } = config;
  if (!tenantId && !clientId && !clientSecret) return undefined;
  return { tenantId, clientId, clientSecret };
}

const LEASE_MS = 60_000;

export async function claimDueConnector(db: Db): Promise<ConnectorScheduleDoc | null> {
  const { ConnectorSchedules } = getCollections(db);
  const now = new Date();

  // Due when never polled, or now - lastPolledAt >= pollingIntervalMs.
  // Filter server-side so we only claim schedules that actually need polling —
  // avoids resetting lastPolledAt every worker tick and starving the interval.
  return ConnectorSchedules.findOneAndUpdate(
    {
      status: 'ACTIVE',
      $or: [
        { lastPolledAt: { $exists: false } },
        {
          $expr: {
            $gte: [
              { $subtract: [now, '$lastPolledAt'] },
              '$pollingIntervalMs',
            ],
          },
        },
      ],
    },
    {
      $set: {
        ownerId: uuidv4(),
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );
}

function emailDedupeKey(email: GraphEmail): string {
  return createHash('sha256')
    .update(`${email.receivedDateTime}|${email.from.emailAddress.address}|${email.subject}`)
    .digest('hex')
    .slice(0, 16);
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
      toRecipients: email.toRecipients.map(r => r.emailAddress),
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

async function handleGraphMailbox(
  db: Db,
  schedule: ConnectorScheduleDoc,
  onMailReceived?: OnMailReceivedFn,
): Promise<number> {
  const mailbox = schedule.config.mailbox;
  if (!mailbox) {
    console.error(`[Connector] graph-mailbox schedule ${schedule._id} has no mailbox configured`);
    return 0;
  }

  const creds = extractCredentials(schedule.config);
  const emails = await pollMailbox(mailbox, { credentials: creds });
  let started = 0;

  for (const email of emails) {
    const dedupeKey = emailDedupeKey(email);
    if (schedule.cursor && schedule.cursor >= dedupeKey) continue;

    try {
      // 1. Create the instance with the START continuation DEFERRED. Tokens will not advance
      //    until we explicitly insert the continuation after onMailReceived finishes — this
      //    prevents the BPMN engine from firing service tasks concurrently with async setup
      //    (attachment downloads, RAG processing, data-pool seeding, etc.).
      const startingTenantId =
        typeof schedule.startingTenantId === 'string' && schedule.startingTenantId.length > 0
          ? schedule.startingTenantId
          : undefined;
      const commandId = uuidv4();
      const { instanceId } = await startInstance(db, {
        commandId,
        definitionId: schedule.definitionId,
        businessKey: `email:${email.id}`,
        deferContinuation: true,
        ...(startingTenantId ? { tenantId: startingTenantId } : {}),
      });

      console.log(
        `[Connector] graph-mailbox: "${email.subject}" from ${email.from.emailAddress.address}` +
        ` → instance ${instanceId}`
      );

      // 2. List attachment metadata (no content downloaded yet)
      let attachmentMeta: Array<{ id: string; name: string; contentType: string; size: number }> = [];
      if (email.hasAttachments) {
        try {
          attachmentMeta = await listAttachments(mailbox, email.id, creds);
        } catch (err) {
          console.error(`[Connector] Failed to list attachments for ${email.id}:`, err);
        }
      }

      // 3. Call onMailReceived — caller stores domain data, downloads attachments on demand.
      //    We await this fully before releasing the BPMN engine.
      let skip = false;
      if (onMailReceived) {
        try {
          const result = await onMailReceived(
            toMailEvent(mailbox, email, instanceId, schedule.definitionId, attachmentMeta, creds),
          );
          if (result && result.skip) {
            skip = true;
          }
        } catch (err) {
          console.error(`[Connector] onMailReceived failed for ${email.id}:`, err);
          skip = true;
        }
      }

      // 4. If skipped, terminate the instance (no continuation was ever inserted, so the
      //    BPMN engine never sees it). Otherwise release the engine by inserting the
      //    START continuation now.
      if (skip) {
        const { ProcessInstances, ProcessInstanceState } = getCollections(db);
        await ProcessInstances.updateOne(
          { _id: instanceId },
          { $set: { status: 'TERMINATED', endedAt: new Date() } },
        );
        await ProcessInstanceState.updateOne(
          { _id: instanceId },
          { $set: { status: 'TERMINATED' } },
        );
        console.log(`[Connector] Skipped instance ${instanceId} (onMailReceived returned skip)`);
      } else {
        await insertStartContinuation(db, { instanceId, commandId });
      }

      await markAsRead(mailbox, email.id, creds);
      started++;
    } catch (err) {
      console.error(`[Connector] Failed to start instance for email ${email.id}:`, err);
    }
  }

  return started;
}

async function releaseSchedule(db: Db, schedule: ConnectorScheduleDoc): Promise<void> {
  const { ConnectorSchedules } = getCollections(db);
  await ConnectorSchedules.updateOne(
    { _id: schedule._id },
    {
      $set: { lastPolledAt: new Date(), updatedAt: new Date() },
      $unset: { ownerId: '', leaseUntil: '' },
    },
  );
}

export async function processOneConnector(
  db: Db,
  onMailReceived?: OnMailReceivedFn,
): Promise<boolean> {
  const schedule = await claimDueConnector(db);
  if (!schedule) return false;

  try {
    if (schedule.connectorType === 'graph-mailbox') {
      await handleGraphMailbox(db, schedule, onMailReceived);
    } else {
      console.warn(`[Connector] Unknown connector type: ${schedule.connectorType}`);
    }
  } catch (err) {
    console.error(`[Connector] Poll failed for ${schedule.connectorType} (${schedule._id}):`, err);
  }

  await releaseSchedule(db, schedule);
  return true;
}
