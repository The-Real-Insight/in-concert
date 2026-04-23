---
title: "BPMN as config: one vocabulary runs the model, the runtime, and the analytics"
published: false
description: "Camunda and Flowable preserve your extension attributes at runtime — but their ergonomic gradient pulls you toward each engine's own extension schema. in-concert flattens that: the callback payload IS the attribute bag, so your `acme:*` is no more expensive than a vendor vocabulary. One vocabulary, authored in bpmn.io, drives modeling, execution, and analytics without translation."
tags: bpmn, workflow, architecture, ai
cover_image: ""
canonical_url: ""
---

BPMN 2.0 lets you put arbitrary attributes in your own namespace on any element. The established BPM runtimes — **Camunda** and **Flowable** — both preserve those attributes through parsing and make them accessible at runtime. That's table stakes for the spec; neither engine violates it.

What differs is *how* those attributes reach your code. In Camunda, a Java delegate pulls the current BPMN model instance, walks to the element in question, and reads the namespaced attribute through the generic model API — `execution.getBpmnModelElementInstance().getAttributeValueNs(ns, name)`. Flowable's pattern is similar. Both work, both have a decade of production runtime behind them. Over time, though, the path of least resistance steers teams toward each engine's own extension schema — `camunda:inputOutput`, `camunda:properties`, `flowable:field` — because the platform does more lifting when you author in its vocabulary. Gradually the *engine's* vocabulary starts winning over the *business's*.

**in-concert** — the BPMN 2.0 engine I work on — flattens that ergonomic gradient. There is no engine-defined extension schema for service tasks, user tasks, sequence flows, or gateways. What the engine does instead: hand your callback every attribute you authored, as a plain JavaScript bag in the payload.

```typescript
item.payload.extensions['acme:costCenter']
transition.attrs['acme:condition1']
```

No model traversal. No namespace-aware API calls. No translation step. Whether you use our bundled `tri:*` prefix (which the built-in triggers happen to ship with) or your own `acme:*` is invisible to the engine — the authoring surface is intentionally unbiased, so your vocabulary wins by default.

The rest of this article is what that means in practice — from bpmn.io, through four extension points at runtime, to the analytics payoff.

## Step 1 — Author it in the modeler

Pick any BPMN editor. bpmn.io is free and runs in the browser; Camunda Modeler is an Electron app; you can hand-edit XML if you prefer. All three save extension attributes the same way. Here's a fragment of a loan-approval process with four extension points, each carrying `acme:*` attributes my fictional company authored for its own runtime:

```xml
<bpmn:definitions
  xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:acme="http://acme.example.com/schema/bpmn">

  <!-- 1. Trigger: start the process when an application arrives -->
  <bpmn:message id="Msg_Application" name="loan-application"
    acme:connectorType="acme-application-inbox"
    acme:source="customer-portal"
    acme:minAmount="1000" />

  <bpmn:process id="LoanApproval" isExecutable="true">
    <bpmn:startEvent id="Start">
      <bpmn:messageEventDefinition messageRef="Msg_Application" />
    </bpmn:startEvent>

    <!-- 2. Service task: call out to a credit scoring tool -->
    <bpmn:serviceTask id="Task_Score" name="Run credit score"
      acme:toolId="credit-score-v2"
      acme:timeoutSeconds="5"
      acme:retryStrategy="exponential"
      acme:costCenter="risk-ops" />

    <!-- 3. User task: have an underwriter review -->
    <bpmn:userTask id="Task_Review" name="Underwriter review"
      acme:roleId="senior-underwriter"
      acme:formSchema="loan-review-v3"
      acme:slaMinutes="240"
      acme:escalationChannel="slack:#underwriting-escalation" />

    <!-- 4. Transition conditions with authored rule metadata -->
    <bpmn:exclusiveGateway id="Gw_Decide" name="Approve?" default="Flow_Reject" />

    <bpmn:sequenceFlow id="Flow_Approve" sourceRef="Gw_Decide" targetRef="End_Approved"
      name="Approve"
      acme:condition1="score_above_threshold"
      acme:condition2="amount_within_limits"
      acme:explanation="Auto-approve when both the credit score and the loan amount are in band." />

    <bpmn:sequenceFlow id="Flow_Reject" sourceRef="Gw_Decide" targetRef="End_Rejected"
      name="Reject"
      acme:explanation="Everything else routes to manual review." />

    <!-- …endEvents, the other flows… -->
  </bpmn:process>
</bpmn:definitions>
```

Four extension points, each of which would normally force you to either contort into the engine's vocabulary or split your logic into an external config. Here, each attribute is just part of the BPMN — one file, one change, one commit.

## Step 2 — The engine parses *everything*

Deploy the model. The parser picks up every non-reserved `<prefix>:<name>` attribute (reserved: `bpmn`, `bpmndi`, `dc`, `di`, `xsi`, `xml`, `xmlns`) and carries the bags verbatim into the internal graph model:

- `<bpmn:message>` extension attributes → `node.messageAttrs`
- `<bpmn:startEvent>` extension attributes → `node.selfAttrs`
- `<bpmn:serviceTask>` / `<bpmn:userTask>` extension attributes → `node.extensions`
- `<bpmn:sequenceFlow>` extension attributes → `flow.selfAttrs`

The engine **does not** look inside these bags. It doesn't check `acme:toolId`. It doesn't parse `acme:condition1`. It doesn't know what `escalationChannel` means. These are opaque strings that the engine is legally obligated to carry from XML to your handlers, and nothing more.

## Step 3 — Your handlers consume them

At runtime, each extension point has a callback your handler registers for at engine init. When execution reaches that point, the engine fires the callback with a payload that includes the raw attribute bag. Your handler — written in TypeScript, in your project — reads whatever attributes it authored and does whatever it wants.

### Event trigger

`acme-application-inbox` is a custom trigger plugin your team wrote. It's a `StartTrigger` implementation, roughly 100 lines. When the engine sees the message start event at deploy time, it iterates registered triggers and the plugin claims it based on `acme:connectorType`:

```typescript
class AcmeApplicationInboxTrigger implements StartTrigger {
  readonly triggerType = 'acme-application-inbox';

  claimFromBpmn(event) {
    if (event.messageAttrs?.['acme:connectorType'] !== 'acme-application-inbox') return null;
    return {
      config: {
        source: event.messageAttrs['acme:source'],
        minAmount: Number(event.messageAttrs['acme:minAmount'] ?? 0),
      },
    };
  }

  async fire(invocation) {
    const newApplications = await acmeInbox.poll(invocation.definition.config.source);
    return {
      starts: newApplications
        .filter((a) => a.amount >= invocation.definition.config.minAmount)
        .map((a) => ({ dedupKey: a.id, payload: { application: a } })),
      nextCursor: invocation.cursor,
    };
  }
}
```

The engine doesn't know `acme-application-inbox` exists until you register it. The attributes that parameterize it (`source`, `minAmount`) live on the BPMN — operators can change them in bpmn.io without touching code.

### Service task tool invocation

When execution reaches `Task_Score`, the engine fires `onServiceCall` with a payload that includes the task's `extensions` bag:

```typescript
onServiceCall: async (item) => {
  const ext = item.payload.extensions;
  const toolId = ext?.['acme:toolId'];
  const timeoutSeconds = Number(ext?.['acme:timeoutSeconds'] ?? 30);
  const retryStrategy = ext?.['acme:retryStrategy'] ?? 'none';

  const result = await acmeToolRuntime.invoke(toolId, {
    timeoutMs: timeoutSeconds * 1000,
    retryStrategy,
    input: await readInstanceState(item.instanceId),
  });

  await client.completeExternalTask(item.instanceId, item.payload.workItemId, { result });
}
```

The engine knows nothing about tool invocation. Your tool runtime — in whatever shape it takes, MCP, a gRPC service, a Python subprocess, Anthropic's tool-use API — consumes the attributes and does the work.

### User task / communication

Same mechanism, different handler. When the process reaches `Task_Review`, `onWorkItem` fires:

```typescript
onWorkItem: async (item) => {
  const ext = item.payload.extensions;
  const form = ext?.['acme:formSchema'];
  const slaMinutes = Number(ext?.['acme:slaMinutes'] ?? 1440);
  const escalation = ext?.['acme:escalationChannel'];

  await worklist.create({
    instanceId: item.instanceId,
    workItemId: item.payload.workItemId,
    formSchema: form,
    dueAt: new Date(Date.now() + slaMinutes * 60_000),
    escalateTo: escalation,
  });
}
```

The worklist UI renders `acme:formSchema="loan-review-v3"` however it wants. The escalation job wakes up at the SLA deadline and pings `slack:#underwriting-escalation`. Both services read the same BPMN attributes — no shadow config file.

### Transition conditions

When execution reaches `Gw_Decide`, `onDecision` fires with a `transitions[]` array. Each transition carries its source flow's `attrs` bag:

```typescript
onDecision: async (item) => {
  const { instanceId, transitions } = item.payload;
  const state = await readInstanceState(instanceId);

  const match = transitions.find((t) => {
    if (!t.attrs) return t.isDefault;
    const rule1 = t.attrs['acme:condition1'];
    const rule2 = t.attrs['acme:condition2'];
    return evaluateRule(rule1, state) && evaluateRule(rule2, state);
  });

  await client.submitDecision(instanceId, item.payload.decisionId, {
    selectedFlowIds: [match!.flowId],
  });
}
```

The engine never attempted to evaluate `score_above_threshold`. It just handed you the string. Your rule engine (or LLM, or embedded DSL) does the actual work. The rule names are authored in bpmn.io by whoever models the process.

## Step 4 — Analytics: the same attributes, for free

Here's the part that earns its keep in production.

Every attribute you author on the BPMN — `acme:costCenter`, `acme:customerTier`, `acme:experimentId`, `acme:dataClassification`, `acme:regulatoryRegime` — lands in your system **in the same shape the analytics layer already expects**, because *you* chose the shape. There's no intermediate translation.

A few concrete implications:

- **Cost allocation.** Your finance team already allocates spend by `costCenter`. Put `acme:costCenter="risk-ops"` on every service task that calls a paid API, and your process telemetry joins to your chargeback reports without anyone writing a mapping.
- **Customer-tier SLA reports.** `acme:customerTier` on a user task, and your SLA dashboard filters by tier natively.
- **A/B experimentation.** `acme:experimentId` on the flow your experiment toggles; your experiments platform already aggregates by that id.
- **Compliance audits.** `acme:dataClassification="PII"` on the tasks that read personal data; GDPR audit queries filter on that flag directly, and the same flag is visible to reviewers opening the BPMN in bpmn.io.
- **ML training data.** Every `onDecision` event emits a row with `flowId`, `transitions[].attrs`, and the state the handler saw. Your ML team gets a ready-made training set for the rule engine because the labels were authored in the model.

None of this requires a separate "process metadata" service or a parallel tagging system. The BPMN *is* the config, and the config is whatever vocabulary your business already speaks.

## Why this matters

Camunda and Flowable are mature, battle-tested engines with enormous BPMN coverage and deep Java integration. in-concert doesn't try to compete on that surface area. What it *does* optimize for is a narrower, increasingly relevant shape: **your process model should carry your business vocabulary, and that vocabulary should reach your runtime handlers without an API call**.

The concrete payoff of transparent extension attributes:

- **One source of truth.** Your process logic, tool wiring, form schemas, escalation rules, cost centers, compliance flags — all in the BPMN, all authored in a modeler, all versioned alongside the graph. Not 40% in BPMN and 60% in handler code and YAML.
- **Vocabulary parity across systems.** `acme:customerTier` in the BPMN is the same `customerTier` your analytics warehouse already uses. No translation layer between the model and reporting.
- **Editor independence.** Every BPMN editor that round-trips extension attributes (bpmn.io, Camunda Modeler, Signavio, hand-edited XML) works — nothing in-concert-specific needs to be installed.
- **LLM-friendly.** When your conditions are prompts, your tool calls are MCP-style invocations, and your routing decisions are LLM-evaluated — all of which in-concert supports natively — keeping every attribute in a plain JSON bag at handler time is the right shape for the AI/agentic workloads the engine is positioned for.

The engine's job is to carry BPMN semantics — sequencing, tokens, gateways, events — and get out of the way of the attributes. What happens at each task, at each trigger, at each gateway is yours to author in the model and yours to implement in code. The bridge between the two is the attribute bag.

## Try it

in-concert is open-source (modified MIT with attribution) and on npm as [`@the-real-insight/in-concert`](https://www.npmjs.com/package/@the-real-insight/in-concert). The trigger-plugin guide is at [`docs/sdk/custom-triggers.md`](https://github.com/The-Real-Insight/in-concert/blob/main/docs/sdk/custom-triggers.md); the decision-callback reference with the `transition.attrs` walkthrough is in [`docs/sdk/usage.md`](https://github.com/The-Real-Insight/in-concert/blob/main/docs/sdk/usage.md#decision-callback-payload-llm-friendly).

If you've been splitting process logic across BPMN and config files because your engine wouldn't carry your attributes, swap engines or swap strategies — but don't keep doing it. The model should win.
