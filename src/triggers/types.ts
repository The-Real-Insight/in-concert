/**
 * Start-trigger plugin interface. The engine core knows nothing about
 * specific triggers (timer, mailbox, SharePoint); it only knows this
 * interface and a {@link TriggerRegistry}. All trigger-specific logic —
 * expression parsing, network calls, credential handling — lives under
 * `src/triggers/<name>/` and is registered at engine init.
 *
 * See `docs/sdk/custom-triggers.md` for the authoring guide.
 */

import type { ClientSession, Db } from 'mongodb';

/**
 * Opaque, trigger-owned cursor. The engine persists it verbatim and never
 * inspects it. Delta tokens, ISO timestamps, last-seen IDs, RRULE iterator
 * state — all fit.
 */
export type TriggerCursor = string | null;

/**
 * Parsed trigger configuration, extracted from the BPMN at deploy time.
 * The engine does not interpret `config` — it hands it to the trigger
 * as-is. `config` is the flattened set of `tri:*` attributes plus any
 * standard BPMN attributes the trigger cares about (e.g. `<bpmn:timeCycle>`
 * body for timers).
 */
export type TriggerDefinition = {
  triggerType: string;
  definitionId: string;
  startEventId: string;
  config: Record<string, unknown>;
};

/**
 * One fire of a trigger produces zero or more start requests. The
 * {@link dedupKey} is the engine's exactly-once guarantee: two start
 * requests with the same `dedupKey` (within the same process definition)
 * collapse to a single process instance, across retries, crash recovery,
 * and overlapping polls.
 *
 * Stable key examples:
 *   - mailbox:   Graph message id
 *   - sharepoint: `${driveItemId}@${eTag}` (so eTag bumps count as new events)
 *   - timer:     `${scheduleId}@${fireTimeISO}`
 */
export type StartRequest = {
  dedupKey: string;
  payload: Record<string, unknown>;
};

/**
 * Everything a trigger needs to do its work. `credentials` arrives from
 * per-schedule storage (see `TriggerScheduleDoc.credentials`); if the
 * trigger wants engine-level defaults (env vars, etc.) it reads them
 * itself — the engine core is credential-agnostic.
 */
export type TriggerInvocation = {
  scheduleId: string;
  definition: TriggerDefinition;
  cursor: TriggerCursor;
  credentials: Record<string, unknown> | null;
  now: Date;
  /** Database handle for triggers that need it (rare — most use network APIs only). */
  db: Db;
};

/** Result of one fire. Persisted atomically with any {@link starts}. */
export type TriggerResult = {
  starts: StartRequest[];
  nextCursor: TriggerCursor;
  /** Absent = the scheduler uses {@link StartTrigger.nextSchedule} instead. */
  nextFireAt?: Date;
  /** Last-error string the scheduler should record on the schedule row. */
  lastError?: string;
  /**
   * Mark the schedule as `EXHAUSTED` after this fire. Used by one-shot
   * timers and bounded cycles (R3/PT10M) that have run out of repetitions.
   * `nextFireAt` and `intervalMs` are cleared when set; no further polls
   * will occur until the schedule is manually re-activated.
   */
  exhausted?: boolean;
};

/**
 * How the scheduler should decide when to fire the trigger next.
 *
 * `fire-at`    — timer-shaped: fire at a specific instant.
 * `interval`   — polling-shaped: fire every `ms` milliseconds from
 *                `lastFiredAt` (or now if never fired).
 *
 * A future `push` variant is anticipated for webhook/subscription-based
 * triggers (Graph change notifications), but not implemented — out-of-scope
 * for the initial refactor.
 */
export type TriggerSchedule =
  | { kind: 'fire-at'; at: Date }
  | { kind: 'interval'; ms: number };
// TODO: | { kind: 'push' }

/**
 * Engine-provided snapshot of a BPMN start event passed to
 * {@link StartTrigger.claimFromBpmn}. Intentionally uses raw `tri:*`
 * attribute bags — the engine does not interpret extension attributes;
 * each plugin decides what its own trigger needs.
 */
export type BpmnStartEventView = {
  /** The BPMN start-event node id (`flowEl.id`). */
  nodeId: string;
  /**
   * BPMN primitives the engine unpacks itself. `timerDefinition` is the
   * body of `<bpmn:timeCycle|timeDuration|timeDate>`. `eventDefinitionKind`
   * lets plugins distinguish message-start vs conditional-start vs plain.
   */
  timerDefinition?: string;
  eventDefinitionKind: 'none' | 'timer' | 'message' | 'conditional' | 'signal' | 'other';
  /** `tri:*` attrs on the start event itself and on any nested event-definition child. */
  selfAttrs: Record<string, string>;
  /** `tri:*` attrs on the `bpmn:Message` referenced via messageRef, if any. */
  messageAttrs?: Record<string, string>;
};

/** Outcome of {@link StartTrigger.claimFromBpmn}. `null` means "not mine". */
export type BpmnClaim = {
  /**
   * Plugin-owned config bag, stored verbatim on the `TriggerSchedule` row
   * and handed back to {@link StartTrigger.fire} at invocation time. The
   * engine does not inspect or reshape it.
   */
  config: Record<string, unknown>;
};

/** First-poll behavior. Read from `tri:initialPolicy` on the BPMN. */
export type InitialPolicy = 'fire-existing' | 'skip-existing';

export const INITIAL_POLICY_VALUES: readonly InitialPolicy[] = [
  'fire-existing',
  'skip-existing',
];

/**
 * The plugin contract. Implementations live under `src/triggers/<name>/`.
 * Registration happens at engine init via {@link TriggerRegistry.register}.
 */
export type StartTrigger = {
  /**
   * Stable identifier persisted on `TriggerSchedule.triggerType`. Chosen by
   * the plugin; the engine never hard-codes or compares to specific values.
   */
  readonly triggerType: string;

  /**
   * Inspect a parsed BPMN start event and decide whether this trigger owns
   * it. Return a config bag to claim; return `null` to pass. The first
   * registered trigger whose claim is non-null wins.
   *
   * The config bag is stored verbatim on the `TriggerSchedule` row and
   * passed back on every {@link fire}. The engine never reshapes or
   * interprets it — it's purely a plugin-owned carrier.
   */
  claimFromBpmn(event: BpmnStartEventView): BpmnClaim | null;

  /**
   * Initial `TriggerSchedule.status` when a schedule is first created from a
   * fresh deploy. Defaults to `'PAUSED'` — polling triggers usually need
   * credentials to be set before they start firing, so the host calls
   * `activateSchedules()` to flip them to ACTIVE once configuration is in
   * place. Timer-like triggers whose firing needs no external credentials
   * should override to `'ACTIVE'`.
   */
  readonly deployStatus?: 'ACTIVE' | 'PAUSED';

  /**
   * Called at deploy time for each start event with this trigger type.
   * Throw with a human-readable message on invalid config — the engine
   * surfaces it as a deploy error and the definition is rejected.
   */
  validate(def: TriggerDefinition): void;

  /**
   * Default initial policy when the BPMN does not specify `tri:initialPolicy`.
   * Rationale for the asymmetry: mailbox defaults to `fire-existing` for
   * backward compatibility; polling triggers that can flood a new deployment
   * (SharePoint folders with many existing items) default to `skip-existing`.
   */
  readonly defaultInitialPolicy: InitialPolicy;

  /**
   * Called when the schedule is first created (with `lastFiredAt=null,
   * cursor=null`) and after each successful fire (with the new cursor).
   * Returning `interval` makes the scheduler re-invoke `fire()` every N ms;
   * returning `fire-at` is a one-shot that gets re-evaluated after each call.
   *
   * For fire-at triggers whose timing is determined by the result of
   * `fire()` (e.g. timer), the scheduler prefers `TriggerResult.nextFireAt`
   * and only falls back to `nextSchedule` on the initial creation.
   */
  nextSchedule(
    def: TriggerDefinition,
    lastFiredAt: Date | null,
    cursor: TriggerCursor,
  ): TriggerSchedule;

  /**
   * The actual work. MUST be idempotent with respect to `dedupKey` — the
   * engine guarantees exactly-once process creation, but the trigger itself
   * is responsible for producing stable keys.
   *
   * Triggers may throw on transient errors; the scheduler records the
   * error on the schedule row and retries at the next interval.
   */
  fire(invocation: TriggerInvocation): Promise<TriggerResult>;
};

/**
 * Optional host hook invoked when a trigger produces a {@link StartRequest}
 * but the engine has already seen that `dedupKey`. Useful for telemetry —
 * most engines don't need it.
 */
export type DuplicateStartObserver = (context: {
  scheduleId: string;
  definitionId: string;
  dedupKey: string;
  session: ClientSession | null;
}) => void | Promise<void>;
