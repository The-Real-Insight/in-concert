---
title: "Generalized BPMN triggers: watch files, inboxes, or let an LLM decide when to start"
published: false
description: "BPMN processes traditionally start via API calls. But real events happen in the world — files appear, mailboxes fill, thresholds cross. A generalized trigger mechanism makes 'how my process starts' part of the BPMN itself, not glue code around it."
tags: bpmn, ai, nodejs, workflow
cover_image: ""
canonical_url: ""
---

Most process engines ask you to tell them when to start. *"Dear engine, please spin up a new instance of this workflow now."* That's fine when the event originates in your code — a user clicks a button, a webhook fires, a batch job runs. It's backwards when the event originates in the world.

Someone drops a PDF into a SharePoint folder. An email arrives. A weather sensor reports conditions that *might* matter. A stock price *might* have moved far enough to care. In each of these cases, the process engine should be the one paying attention — and starting instances on your behalf — rather than forcing you to write a separate watcher service that calls `startInstance()` once it notices.

That's what **generalized start triggers** give you. In [`in-concert`](https://github.com/The-Real-Insight/in-concert) — the BPMN 2.0 engine I work on — every way a process can start is an instance of the same plugin interface. Timers, Microsoft 365 mailboxes, SharePoint folders, and (new in the latest release) AI-listener agents are all first-party triggers. The engine handles polling, exactly-once instance creation, crash recovery, pause/resume, and credentials. You write BPMN.

Let me walk through two of the more interesting cases from a user's perspective — file-monitoring and AI-driven evaluation — and wrap up with a note on the abstraction underneath.

## The concept in one paragraph

A **trigger** is a named thing (`timer`, `graph-mailbox`, `sharepoint-folder`, `ai-listener`, or one you write) that can produce start requests. A BPMN author references a trigger by putting `tri:connectorType="..."` on a `<bpmn:message>` element together with a handful of trigger-specific attributes. At deploy time the engine persists a *trigger schedule* — a row that remembers what to watch, how often, whether it's paused, and any credentials. A generic scheduler polls active schedules, calls the matching plugin, and creates process instances for whatever the plugin returns. From your side, that's it. No code writing polling loops, no cron jobs, no webhook receivers to deploy and monitor.

Four properties fall out of this design:

- **Declared in BPMN.** Adding or changing an event source doesn't touch your application code.
- **Exactly-once.** Every generated start carries a dedup key, enforced by a unique index. Crashes, retries, and overlapping polls collapse to a single process instance.
- **Pausable and resumable.** Turn a trigger off for maintenance; turn it back on when you're ready. No redeploy.
- **Credentials per schedule.** Different mailboxes, different tenants, different API keys — stored on the schedule row, not hard-coded.

## Watching a folder: the SharePoint trigger

**Scenario.** Your ops team drops order PDFs into `/Incoming/Orders` on a SharePoint site. Every file should kick off your existing order-processing workflow. The file's metadata (name, size, path, webUrl) becomes the initial variables for the process instance.

Before generalized triggers, some team built and operated one of: a webhook receiver with Azure AD plumbing, a cron job with a "last-seen" state file, a Microsoft Graph change-notification subscription with a public HTTPS endpoint, or — most commonly — a human who checks the folder once a morning. Somebody wrote it, somebody keeps it running, and somebody handles the part where the SharePoint delta token silently expires after 30 days of quiet.

Here's what replaces all of that in the BPMN:

```xml
<bpmn:message id="Msg_NewOrder" name="incoming-orders"
  tri:connectorType="sharepoint-folder"
  tri:siteUrl="https://contoso.sharepoint.com/sites/Operations"
  tri:driveName="Documents"
  tri:folderPath="/Incoming/Orders"
  tri:fileNamePattern="*.pdf"
  tri:pollIntervalSeconds="60"
  tri:initialPolicy="skip-existing" />

<bpmn:startEvent id="Start" name="Order arrived">
  <bpmn:messageEventDefinition messageRef="Msg_NewOrder" />
</bpmn:startEvent>
```

Deploy the process, set your Azure AD app credentials against the generated schedule, and resume it:

```typescript
const [schedule] = await client.listTriggerSchedules({ triggerType: 'sharepoint-folder' });
await client.setTriggerCredentials(schedule._id, { tenantId, clientId, clientSecret });
await client.resumeTriggerSchedule(schedule._id);
```

Done. From now on:

- Every matching file that arrives in the folder starts a process instance with the file's metadata as variables.
- `initialPolicy="skip-existing"` means the engine doesn't flood you with a thousand instances for files that were already there when you deployed. The first poll silently records the current state; only *new* arrivals fire.
- Duplicates from retries, crashes, or overlapping polls collapse to one instance per `(itemId, eTag)`.
- If the delta token expires, the trigger transparently resets and keeps going.
- Need to pause for maintenance? `client.pauseTriggerSchedule(id)`. Resume when ready.

The process designer never sees a polling loop or a state file. The person reviewing the BPMN sees one `<bpmn:message>` element with a handful of attributes that say exactly what's being watched and how.

## Letting an LLM decide: the AI-listener trigger

This one is newer — and harder to do any other way.

**Scenario.** You run an escalation workflow that wakes up the duty officer when severe weather threatens an outdoor event. "Severe" has a definition that evolved over the years: some combination of precipitation, wind, lightning risk, and whether the event is happening on a field, in a stadium, or on a lake. Your current threshold rules are pages long and still miss edge cases.

You'd love to write: *"Given the current observation, should we wake the duty officer?"* And have something qualified answer that question.

An `ai-listener` trigger does precisely that. It polls an MCP-style tool endpoint (any HTTP endpoint that returns JSON), passes the result to an LLM together with a prompt **authored in the BPMN itself**, and starts a process instance when the LLM answers *"yes"*.

```xml
<bpmn:message id="Msg_SevereWeather" name="severe-weather-detected"
  tri:connectorType="ai-listener"
  tri:toolEndpoint="https://weather.example.com/tools/call"
  tri:tool="get_weather"
  tri:llmEndpoint="https://llm.example.com/evaluate"
  tri:prompt="Given this observation for the upcoming regatta at Lake Zurich, should we wake the duty officer? Consider wind above 30 km/h, lightning within 50 km, and heavy rain forecast for the event window. Answer strictly yes or no."
  tri:pollIntervalSeconds="300" />

<bpmn:startEvent id="Start" name="Severe weather">
  <bpmn:messageEventDefinition messageRef="Msg_SevereWeather" />
</bpmn:startEvent>
```

Every five minutes the engine:

1. Calls the weather tool endpoint to fetch current observations.
2. Feeds them to the LLM endpoint together with the prompt.
3. Parses the response for a strict yes/no.
4. On *yes*, starts the escalation process. On *no* or ambiguous output, does nothing.

The escalation process itself is unchanged BPMN — service tasks, user tasks, gateways, the lot. What changed is that it no longer needs an external watchdog service, a threshold spreadsheet, or a person staring at a dashboard.

### The business rule lives in the prompt

This is the part that feels genuinely new. Your "when to escalate" policy is right there in the BPMN, in English, next to the process that implements it. Want to tighten the rule? Edit the prompt. Want to add "ignore conditions during the lunch break"? Edit the prompt. Want a different operator to take a different view? They edit their copy of the prompt.

You get domain experts who can't write TypeScript writing the actual rules of the business.

### Exactly-once across many polls

The interesting subtlety: if the weather has been bad for an hour, you don't want *twelve* escalation instances (one per five-minute poll). You want one.

The trigger's dedup key comes from one of two places:

- **From the LLM itself** — the response can include a `correlationId` that names the ongoing event. `"lake-zurich-storm-2026-04-21"` stays the same across many polls; all those "yes" answers collapse to one process instance.
- **From the tool output** — if the LLM doesn't supply a correlation id, the plugin hashes the tool result. Identical observations → same hash → same instance.

Either way: retries, crashes, overlapping polls, and routine "yes, still yes" cycles all produce one instance per *event*, not one per *observation*. Your handlers don't have to worry about whether they're already running for this storm.

### Bring your own LLM

The default flow is plain HTTP — any MCP-compatible tool server, any LLM with a `POST { prompt, context } → { answer }` endpoint. That keeps the plugin dependency-free and works with whatever inference stack you're already running.

If you'd rather call the Anthropic or OpenAI SDK directly (for retries, structured output, prompt caching), inject a function and skip HTTP entirely:

```typescript
const plugin = getDefaultTriggerRegistry().get('ai-listener') as AIListenerTrigger;

plugin.setEvaluate(async (prompt, context) => {
  const completion = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 20,
    system: 'Answer strictly with yes or no. No other words.',
    messages: [{ role: 'user', content: `${prompt}\n\nData: ${JSON.stringify(context)}` }],
  });
  const text = (completion.content[0] as { text: string }).text;
  return parseEvaluation({ answer: text });
});
```

With that, `tri:llmEndpoint` becomes optional metadata and the plugin calls your function for every evaluation. Same idea for `setCallTool` if you'd rather use an MCP client SDK for the tool half.

## One interface, any source

The real win isn't any one trigger. It's that *how your process starts* becomes part of the BPMN, not a separate service.

Underneath, every trigger — timer, mailbox, SharePoint, AI-listener — implements the same five-method interface:

```typescript
type StartTrigger = {
  readonly triggerType: string;
  readonly defaultInitialPolicy: 'fire-existing' | 'skip-existing';
  validate(def): void;
  nextSchedule(def, lastFiredAt, cursor): TriggerSchedule;
  fire(invocation): Promise<TriggerResult>;
};
```

An S3 bucket watcher, an SQS queue poller, a webhook receiver, a filesystem watcher — any of these is about 100 lines of code against that interface, registered once at engine init. The engine handles scheduling, exactly-once, crash recovery, pause/resume, and credentials on your behalf.

The effect on your codebase is that the boundary between *the world* and *your processes* becomes a BPMN concern rather than a glue-code concern. New event source? Swap one attribute on one message element. Remove it again? Swap it off. The process graph stays the graph; the triggers are plug-ins around it.

## Try it

The engine is open-source (modified MIT with attribution) and on npm as [`@the-real-insight/in-concert`](https://www.npmjs.com/package/@the-real-insight/in-concert). Source, docs, and more triggers at [github.com/The-Real-Insight/in-concert](https://github.com/The-Real-Insight/in-concert).

If you write a trigger for something interesting — an IoT feed, a database change stream, a message bus — I'd love to hear about it. The interface is deliberately small; the space of useful triggers is not.
