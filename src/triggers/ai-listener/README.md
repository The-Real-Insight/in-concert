# AI-listener trigger

Starts a process instance when an LLM — evaluating the current output of an MCP-style tool call — answers `"yes"` to a prompt authored in the BPMN. The canonical use case is a supervisor process that watches an external signal and wakes up only when the LLM judges a threshold crossed.

Two examples:

- **Weather guard.** Tool call fetches current observations for a location; prompt asks *"Is it currently raining heavily enough to stop outdoor ops?"*. Process fires when the answer is yes.
- **Price movement detector.** Tool call fetches a stock quote + its 30-day vol; prompt asks *"Given this quote vs. the historical band, is this a reportable move?"*. Process fires when yes.

The business logic — *how to interpret the signal* — lives in the prompt, not in code.

## BPMN shape

```xml
<bpmn:message id="Msg_RainDetected" name="ai-rain-detector"
  tri:connectorType="ai-listener"
  tri:toolEndpoint="https://weather.example.com/tools/call"
  tri:tool="get_weather"
  tri:llmEndpoint="https://llm.example.com/evaluate"
  tri:prompt="Given this weather observation, is it currently raining? Answer strictly yes or no."
  tri:pollIntervalSeconds="120"
  tri:initialPolicy="skip-existing" />

<bpmn:startEvent id="Start">
  <bpmn:messageEventDefinition messageRef="Msg_RainDetected" />
</bpmn:startEvent>
```

## `tri:*` attributes

| Attribute | Required | Default | Meaning |
|---|---|---|---|
| `tri:connectorType` | yes | — | Must be `"ai-listener"`. |
| `tri:toolEndpoint` | yes | — | URL receiving `POST { tool }`; returns the tool output as JSON. |
| `tri:tool` | yes | — | Tool name (passed in the POST body, also used in the dedup fallback). |
| `tri:llmEndpoint` | yes† | — | URL receiving `POST { prompt, context }`; returns `{ decision | answer, reason?, correlationId? }`. †Not required if the host injects an `evaluate` function via the plugin constructor. |
| `tri:prompt` | yes | — | The evaluation prompt sent to the LLM along with the tool output. |
| `tri:pollIntervalSeconds` | no | `"120"` | Polling cadence. Minimum `30`. |
| `tri:initialPolicy` | no | `"skip-existing"` | On first poll, `"fire-existing"` fires even if the LLM says yes immediately; `"skip-existing"` primes the schedule silently. |

`validate()` rejects the deploy if any required field is missing or if `pollIntervalSeconds < 30`.

## Call flow

1. Plugin calls `toolEndpoint` with `POST { tool }`. Response is JSON (any shape).
2. Plugin calls `llmEndpoint` with `POST { prompt, context: toolOutput }`.
3. Plugin parses the LLM response — accepting either `{ decision: "yes" | "no", ... }` or `{ answer: "... yes ..." }`, case-insensitive, word-boundary matched.
4. On `"yes"` → one `StartRequest` emitted with the tool output and reason as payload.
5. On `"no"` or ambiguous → no start, cursor unchanged.

## Dedup key

- If the LLM response includes `correlationId`, that's the dedup key (prefixed with `scheduleId:`). This lets the detector name the *event* it saw — `"zone-7-flood"` stays one instance across many polls while the event is ongoing.
- Otherwise, the key is a 16-char hash of the tool output. Identical tool outputs → one instance.

Pick whichever semantics fit. `correlationId` is almost always what you want for real-world deployments.

## Credentials

Per-schedule credentials pass through to both the tool call (as `toolApiKey`) and the LLM call (as `llmApiKey`):

```typescript
await client.setTriggerCredentials(scheduleId, {
  toolApiKey: 'tool-bearer-xxx',
  llmApiKey: 'sk-ant-xxx',
});
```

The default HTTP helpers send these as `Authorization: Bearer <key>`. Hosts that need a different auth scheme should inject their own `callTool` / `evaluate` via the plugin constructor.

## Bypassing HTTP (tests, or direct SDK integration)

For deterministic testing — or for hosts that prefer to hit the Anthropic / OpenAI SDKs directly — construct the trigger with callbacks:

```typescript
import { AIListenerTrigger, getDefaultTriggerRegistry } from '@the-real-insight/in-concert/triggers';

const plugin = getDefaultTriggerRegistry().get('ai-listener') as AIListenerTrigger;
// Both overrides receive the full trigger config as the fourth argument
// (every `tri:*` attribute on the BPMN minus the connectorType discriminator).
// Use it to forward parameter overwrites, offer type, locale, etc. to your
// in-process tool runtime without a second round-trip to the schedule row.
plugin.setCallTool(async (tool, _endpoint, _creds, config) => {
  const overrides = config?.parameterOverwrites
    ? JSON.parse(String(config.parameterOverwrites))
    : undefined;
  return await mcp.callTool(tool, overrides);
});
plugin.setEvaluate(async (prompt, context, _creds, _config) => {
  const completion = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 20,
    messages: [{ role: 'user', content: `${prompt}\n\nData: ${JSON.stringify(context)}` }],
  });
  const text = (completion.content[0] as { text: string }).text;
  // Re-use the built-in parser for uniform behavior.
  return parseEvaluation({ answer: text });
});
```

When either override is set, the plugin skips the corresponding HTTP call entirely — the matching `tri:*` endpoint becomes optional (`llmEndpoint`) or is treated as metadata (`toolEndpoint`).

### `config` argument

The fourth argument to both overrides is the plugin-owned config bag — i.e. every attribute that `claimFromBpmn` kept after stripping the namespace prefix. For the bundled AI-listener that means `tool`, `toolEndpoint`, `prompt`, `llmEndpoint`, `pollIntervalSeconds`, `initialPolicy`, and any additional attributes the operator added on the BPMN (e.g. `parameterOverwrites`, `offerType`, `offerId`). The type is `Record<string, unknown>` because values are whatever the plugin chose to store — the engine never coerces.

Existing implementations written for 0.2.x that only declare three parameters keep working unchanged; JavaScript ignores the extra argument at the call site and TypeScript sees the fourth as optional.

## Gotchas

1. **The LLM is the business rule.** Two operators reading the same prompt should agree on the answer — write prompts that explicitly define edge cases ("ignore drizzle", "count only weekday observations").
2. **Polling cost.** Every fire costs a tool call and an LLM call. Set `pollIntervalSeconds` generously — most real detections don't need sub-minute cadence.
3. **Unclear answers don't fire.** If the LLM hedges ("probably yes"), the plugin records it as `unclear` and emits no start. Constrain the model with a system prompt like "Answer strictly `yes` or `no`, no other words."
4. **Dedup is only as good as your key.** Hashing the tool output means small field changes (timestamps, request IDs) fire new instances every poll. Prefer supplying a `correlationId` from the LLM that names the *situation*, not the *observation*.
5. **LLM failures retry next tick.** If the evaluator throws, the scheduler records `lastError` on the schedule row and releases the lease; the next poll tries again. No duplicate instances — nothing was created.

## See also

- Full interface: [`src/triggers/types.ts`](../types.ts).
- Writing your own: [`docs/sdk/custom-triggers.md`](../../../docs/sdk/custom-triggers.md).
