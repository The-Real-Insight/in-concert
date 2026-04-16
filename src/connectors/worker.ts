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
import { startInstance } from '../instance/service';
import { pollMailbox, markAsRead, listAttachments, getAttachmentContent, type GraphEmail } from './graph';
import type { MailReceivedEvent, MailReceivedResult } from '../sdk/types';

export type OnMailReceivedFn = (event: MailReceivedEvent) => Promise<MailReceivedResult>;

const LEASE_MS = 60_000;

export async function claimDueConnector(db: Db): Promise<ConnectorScheduleDoc | null> {
  const { ConnectorSchedules } = getCollections(db);
  const now = new Date();

  return ConnectorSchedules.findOneAndUpdate(
    {
      status: 'ACTIVE',
      $or: [
        { lastPolledAt: { $exists: false } },
        { lastPolledAt: { $lte: new Date(now.getTime() - 1) } },
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

function isDue(schedule: ConnectorScheduleDoc): boolean {
  if (!schedule.lastPolledAt) return true;
  return Date.now() - new Date(schedule.lastPolledAt).getTime() >= schedule.pollingIntervalMs;
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
      getAttachmentContent(mailbox, email.id, attachmentId),
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

  const emails = await pollMailbox(mailbox);
  let started = 0;

  for (const email of emails) {
    const dedupeKey = emailDedupeKey(email);
    if (schedule.cursor && schedule.cursor >= dedupeKey) continue;

    try {
      // 1. Create the instance (exists but no tokens advancing yet)
      const { instanceId } = await startInstance(db, {
        commandId: uuidv4(),
        definitionId: schedule.definitionId,
        businessKey: `email:${email.id}`,
      });

      console.log(
        `[Connector] graph-mailbox: "${email.subject}" from ${email.from.emailAddress.address}` +
        ` → instance ${instanceId}`
      );

      // 2. List attachment metadata (no content downloaded yet)
      let attachmentMeta: Array<{ id: string; name: string; contentType: string; size: number }> = [];
      if (email.hasAttachments) {
        try {
          attachmentMeta = await listAttachments(mailbox, email.id);
        } catch (err) {
          console.error(`[Connector] Failed to list attachments for ${email.id}:`, err);
        }
      }

      // 3. Call onMailReceived — caller stores domain data, downloads attachments on demand
      let skip = false;
      if (onMailReceived) {
        try {
          const result = await onMailReceived(
            toMailEvent(mailbox, email, instanceId, schedule.definitionId, attachmentMeta),
          );
          if (result && result.skip) {
            skip = true;
          }
        } catch (err) {
          console.error(`[Connector] onMailReceived failed for ${email.id}:`, err);
          skip = true;
        }
      }

      // 4. If skipped, terminate the instance; otherwise the START continuation
      //    (already inserted by startInstance) will advance the process
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
      }

      await markAsRead(mailbox, email.id);
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
  if (!isDue(schedule)) {
    await releaseSchedule(db, schedule);
    return false;
  }

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
