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
import { pollMailbox, markAsRead, type GraphEmail } from './graph';

const LEASE_MS = 60_000;

export async function claimDueConnector(db: Db): Promise<ConnectorScheduleDoc | null> {
  const { ConnectorSchedules } = getCollections(db);
  const now = new Date();

  return ConnectorSchedules.findOneAndUpdate(
    {
      status: 'ACTIVE',
      $or: [
        { lastPolledAt: { $exists: false } },
        { lastPolledAt: { $lte: new Date(now.getTime() - 1) } }, // will be refined per-schedule below
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

async function handleGraphMailbox(
  db: Db,
  schedule: ConnectorScheduleDoc,
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

    // Skip if we've already processed this email (cursor tracks last processed key)
    if (schedule.cursor && schedule.cursor >= dedupeKey) continue;

    try {
      const { instanceId } = await startInstance(db, {
        commandId: uuidv4(),
        definitionId: schedule.definitionId,
        businessKey: `email:${email.id}`,
      });

      console.log(
        `[Connector] graph-mailbox: "${email.subject}" from ${email.from.emailAddress.address}` +
        ` → instance ${instanceId}`
      );

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

export async function processOneConnector(db: Db): Promise<boolean> {
  const schedule = await claimDueConnector(db);
  if (!schedule) return false;
  if (!isDue(schedule)) {
    // Claimed but not yet due — release immediately
    await releaseSchedule(db, schedule);
    return false;
  }

  try {
    if (schedule.connectorType === 'graph-mailbox') {
      await handleGraphMailbox(db, schedule);
    } else {
      console.warn(`[Connector] Unknown connector type: ${schedule.connectorType}`);
    }
  } catch (err) {
    console.error(`[Connector] Poll failed for ${schedule.connectorType} (${schedule._id}):`, err);
  }

  await releaseSchedule(db, schedule);
  return true;
}
