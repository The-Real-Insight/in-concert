# Self-Starting Processes: Timer Events, Mailbox Polling, and Why Your Agentic Workflows Should Launch Themselves

*Follow-up to [Why We Keep Process Data Outside the Engine](https://dev.to/marcgillesepehri/why-we-keep-process-data-outside-the-engine-and-why-it-changes-everything-for-agentic-bpm-27p4)*

---

In the first article, we made the case for keeping process data outside the engine. The `instanceId` is the only binding key. Your code handles the intelligence. The engine handles the orchestration.

But there was a gap in that story. Someone still had to start the process.

A REST call. A button click. A cron job in a separate service calling `startInstance()`. The engine could orchestrate anything — once a human or an external trigger told it to begin. The process itself had no agency over its own lifecycle.

That changes now.

## Processes That Start Themselves

in-concert now supports **timer start events** and **message start events** — standard BPMN elements that let a process definition declare when and why it should launch, without any external trigger.

A timer start event says: *run this process every hour*. Or every weekday at 8:30. Or on the last Friday of every month. Or three times at 10-minute intervals, then stop.

A message start event says: *run this process when an email arrives in this mailbox*.

Deploy the BPMN. The engine takes it from there. No Lambda functions. No external scheduler. No webhook plumbing. The process definition is self-sufficient.

## Timer Start Events — Every Flavour of "When"

Put a timer on a start event and the engine creates a persistent schedule. A background worker fires it, starts an instance, advances the schedule, and goes back to sleep. If the server restarts, the schedule is in MongoDB — nothing is lost.

```xml
<bpmn:startEvent id="TimerStart" name="Daily compliance check">
  <bpmn:timerEventDefinition>
    <bpmn:timeCycle>R/P1D</bpmn:timeCycle>
  </bpmn:timerEventDefinition>
</bpmn:startEvent>
```

That is a process that runs once a day, forever, until you pause it. The engine supports five expression formats:

| Format | Example | What it does |
|--------|---------|-------------|
| ISO 8601 repeating interval | `R/PT1H`, `R3/PT10M` | Every hour (unbounded), or 3 times at 10-min intervals |
| ISO 8601 duration | `PT30M` | Once, 30 minutes after deploy |
| ISO 8601 date-time | `2026-12-25T00:00:00Z` | Once, at that exact moment |
| Cron (5-field) | `30 8 * * 1-5` | Weekdays at 8:30 |
| RRULE (RFC 5545) | `FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1` | Last Friday of every month |

RRULE is the format behind Outlook and Google Calendar recurrence. Any pattern you can set in a calendar invitation, you can use to schedule a process. `FREQ`, `INTERVAL`, `BYDAY`, `BYMONTHDAY`, `BYMONTH`, `BYSETPOS`, `COUNT`, `UNTIL` — all supported. Zero external dependencies.

```xml
<bpmn:startEvent id="TimerStart" name="Last Friday of every month">
  <bpmn:timerEventDefinition>
    <bpmn:timeCycle>DTSTART:20260130T090000Z
RRULE:FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1</bpmn:timeCycle>
  </bpmn:timerEventDefinition>
</bpmn:startEvent>
```

Pause and resume any schedule at runtime via the SDK or REST API. The schedule is a first-class object — queryable, manageable, observable.

```typescript
const schedules = await client.listTimerSchedules({ definitionId });
await client.pauseTimerSchedule(schedules[0]._id);
// ... later
await client.resumeTimerSchedule(schedules[0]._id);
```

### Why This Matters for Agentic Workflows

Agentic systems are not request-response. They are continuous. A compliance monitoring agent should check every morning whether anything changed overnight. A portfolio rebalancing agent should evaluate positions on a schedule. A reporting agent should assemble and distribute summaries at the end of every week.

These are not one-off tasks triggered by a user. They are standing processes with their own heartbeat. Timer start events give them that heartbeat — expressed in standard BPMN, persisted in the engine, surviving restarts and deployments.

## Message Start Events — Email as a Process Trigger

Timer events handle "when." Message events handle "what happened."

A message start event with the `graph-mailbox` connector tells the engine: poll this Microsoft 365 mailbox, and when an unread email arrives, start a process instance.

```xml
<bpmn:message id="Msg_Inbox" name="inbox-poll"
  tri:connectorType="graph-mailbox"
  tri:mailbox="support@your-company.com" />

<bpmn:startEvent id="Start" name="Email received">
  <bpmn:messageEventDefinition messageRef="Msg_Inbox" />
</bpmn:startEvent>
```

Two `tri:` extension attributes on the `<bpmn:message>` element identify the connector type and the mailbox. The Graph API credentials are configured once as engine settings — environment variables or SDK `init()` — and never appear in the BPMN.

Deploy the process. The engine polls. An email arrives. A process instance is created.

### The onMailReceived Callback

Here is where the "data outside the engine" principle from the first article meets the real world.

The engine creates the process instance — so you have an `instanceId` — but does not advance a single token until your callback returns. Your code receives the full email: subject, sender, body, and attachment metadata. You store it in your domain. You decide whether to proceed.

```typescript
client.init({
  connectors: {
    'graph-mailbox': {
      tenantId: process.env.GRAPH_TENANT_ID,
      clientId: process.env.GRAPH_CLIENT_ID,
      clientSecret: process.env.GRAPH_CLIENT_SECRET,
    },
  },

  onMailReceived: async ({ mailbox, email, instanceId, getAttachmentContent }) => {
    // Store the email in your domain, bound to the process instance
    await myStore.saveEmail(instanceId, {
      subject: email.subject,
      from: email.from.address,
      body: email.body.content,
      receivedAt: email.receivedDateTime,
    });

    // Download attachments on demand — metadata is already there, content is lazy
    for (const att of email.attachments) {
      const buffer = await getAttachmentContent(att.id);
      await myStorage.upload(instanceId, att.name, buffer, att.contentType);
    }

    // Return { skip: true } to terminate the instance without running
    if (isSpam(email)) return { skip: true };
  },

  onServiceCall: async ({ instanceId, payload }) => {
    // Your agentic logic — LLM calls, tool invocations, etc.
  },
});
```

Attachments are not pre-loaded into memory. The callback receives metadata — name, content type, size — and a `getAttachmentContent()` function that downloads a single attachment on demand. A 40 MB zip does not sit in your Node process unless you explicitly ask for it.

The `{ skip: true }` return value terminates the instance. Spam filter, sender allowlist, duplicate detection — your code, your rules. The engine created the instance so you have an `instanceId` to correlate against. If you skip, it is cleanly terminated. If you proceed, the process runs.

### Why This Matters for Agentic Workflows

Email is the entry point for most business processes in the real world. Customer requests, supplier invoices, regulatory notifications, internal approvals — they arrive as emails with attachments, and someone has to triage them, extract data, route them, and act.

This is exactly what agentic workflows do. The BPMN process models the routing. The LLM handles the triage and extraction. The human task is the escalation point when the AI is uncertain. And now the trigger — the email itself — is part of the process definition.

No middleware. No separate polling service. No Azure Function glue. The BPMN file declares the mailbox. The engine polls it. Your `onMailReceived` callback stores the data. The process runs.

A support email arrives → the agent extracts the intent → checks the knowledge base → drafts a response → routes to a human reviewer if confidence is low → sends the reply. All modelled in BPMN. All starting from an email. All running without anyone clicking "start."

## The Architecture — Same Pattern, Different Triggers

Both timer and message start events follow the same internal pattern we use for the continuation worker:

1. **Deploy** creates a persistent schedule document in MongoDB
2. **Worker loop** polls for due schedules, claims with an optimistic lease
3. **Fire** calls `startInstance()` — same as if you called it yourself via the API
4. **Advance** updates the schedule (next fire time, or mark as exhausted)

Multi-instance safe. Survives restarts. No in-memory state. The schedule is a MongoDB document with an index — the same infrastructure the engine already uses for continuations and outbox delivery.

## Come Build With Us

Timer and message start events are available now in `@the-real-insight/in-concert` on npm. The full documentation — RRULE expressions, cron, Graph mailbox setup, `onMailReceived` callback reference — is in the [SDK usage guide](https://github.com/The-Real-Insight/in-concert/blob/main/docs/sdk/usage.md).

If you are building agentic workflows and want your processes to have their own lifecycle — starting on a schedule, reacting to emails, running continuously without external triggers — this is the engine layer for that.

Star the repo. Try it on a real process. Open an issue if something does not work the way you expect. The BPMN subset is growing, and the patterns we are building — timer-driven agents, email-triggered workflows, LLM-routed decisions — are where #agenticbpm gets practical.

We are The Real Insight GmbH, and we believe BPMN is the orchestration backbone for the agentic era. Processes should not wait to be told when to start. They should know.

→ [github.com/The-Real-Insight/in-concert](https://github.com/The-Real-Insight/in-concert)
→ [npmjs.com/package/@the-real-insight/in-concert](https://www.npmjs.com/package/@the-real-insight/in-concert)
→ [the-real-insight.com](https://the-real-insight.com)

*Powered by The Real Insight GmbH BPMN Engine — [the-real-insight.com](https://the-real-insight.com)*
