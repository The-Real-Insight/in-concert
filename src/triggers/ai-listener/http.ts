/**
 * HTTP helpers for the AI-listener trigger's default flow. Kept in its
 * own module so tests can `jest.mock('./http')` without touching the
 * rest of the plugin.
 *
 * The shapes here are deliberately simple — most real integrations will
 * wrap a proper MCP client and a proper LLM SDK and inject the result
 * via the trigger's constructor options instead of going through HTTP.
 */

export type ToolCallCredentials = {
  toolApiKey?: string;
  [k: string]: unknown;
};

export type LlmCallCredentials = {
  llmApiKey?: string;
  [k: string]: unknown;
};

/**
 * Call the MCP-style tool endpoint with `POST { tool }`. The server is
 * expected to return the tool's output as JSON. Consumers can pre-sign
 * the call via `toolApiKey` in credentials.
 */
export async function callTool(
  endpoint: string,
  tool: string,
  credentials?: ToolCallCredentials,
): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (credentials?.toolApiKey) headers.Authorization = `Bearer ${credentials.toolApiKey}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tool }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tool call failed (${res.status}): ${text}`);
  }
  return res.json();
}

export type EvaluationResult = {
  decision: 'yes' | 'no' | 'unclear';
  reason?: string;
  /**
   * Optional dedup seed supplied by the detector. When set, the trigger
   * uses it as the StartRequest dedupKey instead of hashing the tool
   * result. Useful when the detector wants to name the "event" it detected
   * (e.g. `"heavy-rain-zone-7"`) and collapse repeat detections.
   */
  correlationId?: string;
};

/**
 * POST `{ prompt, context }` to the LLM endpoint and parse a yes/no
 * decision out of the response body. Accepts two response shapes:
 *
 *   { answer: "yes" | "no" | "yes, because ..." }
 *   { decision: "yes" | "no", reason?: "...", correlationId?: "..." }
 *
 * The parser is deliberately permissive: it scans the text for the
 * standalone tokens "yes" or "no" (case-insensitive, word-boundary
 * matched). Anything else is reported as `"unclear"` so the scheduler
 * logs it as a non-fire rather than firing on ambiguous output.
 */
export async function evaluateWithLlm(
  endpoint: string,
  prompt: string,
  context: unknown,
  credentials?: LlmCallCredentials,
): Promise<EvaluationResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (credentials?.llmApiKey) headers.Authorization = `Bearer ${credentials.llmApiKey}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt, context }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM call failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as {
    answer?: string;
    decision?: string;
    reason?: string;
    correlationId?: string;
  };
  return parseEvaluation(json);
}

export function parseEvaluation(json: {
  answer?: string;
  decision?: string;
  reason?: string;
  correlationId?: string;
}): EvaluationResult {
  const raw = String(json.decision ?? json.answer ?? '').toLowerCase();
  const isYes = /\byes\b/.test(raw);
  const isNo = /\bno\b/.test(raw);
  if (isYes && !isNo) {
    return { decision: 'yes', reason: json.reason, correlationId: json.correlationId };
  }
  if (isNo && !isYes) {
    return { decision: 'no', reason: json.reason, correlationId: json.correlationId };
  }
  return {
    decision: 'unclear',
    reason: json.reason ?? `Could not parse a yes/no answer from: ${raw.slice(0, 100)}`,
  };
}
