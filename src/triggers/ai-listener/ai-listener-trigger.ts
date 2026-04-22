/**
 * AI-listener trigger. Polls an MCP-style tool endpoint, feeds the result
 * to an LLM together with a BPMN-authored prompt, and starts a process
 * instance when the LLM answers "yes".
 *
 * The classic example is a supervisor process that watches an external
 * signal ("is it currently raining in zone 7?", "has the stock moved
 * more than 3% today?") and wakes up only when the signal crosses a
 * threshold. The business logic — how to interpret the signal — lives
 * in the prompt, not in code.
 *
 * State model:
 *   - Tool call:     POST { tool } to tri:toolEndpoint → JSON output
 *   - LLM call:      POST { prompt, context: toolOutput } to tri:llmEndpoint
 *                    → { answer|decision: "yes"|"no", reason?, correlationId? }
 *   - Dedup key:     response.correlationId ?? sha256(toolOutput)
 *
 * Tests and hosts that want to skip HTTP entirely can inject `callTool`
 * and/or `evaluate` via the constructor.
 */
import { createHash } from 'crypto';
import {
  callTool as defaultCallTool,
  evaluateWithLlm as defaultEvaluateWithLlm,
  type EvaluationResult,
} from './http';
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

export const AI_LISTENER_TRIGGER_TYPE = 'ai-listener';

const DEFAULT_POLL_SECONDS = 120;
const MIN_POLL_SECONDS = 30;

export type ToolCallerFn = (
  tool: string,
  endpoint: string,
  credentials: Record<string, unknown> | null,
) => Promise<unknown>;

export type EvaluatorFn = (
  prompt: string,
  toolResult: unknown,
  credentials: Record<string, unknown> | null,
) => Promise<EvaluationResult>;

export type AIListenerTriggerOptions = {
  /** Override the default HTTP tool-call. Useful for tests and MCP SDK integrations. */
  callTool?: ToolCallerFn;
  /** Override the default HTTP LLM-call. Useful for tests and direct Anthropic/OpenAI SDK integrations. */
  evaluate?: EvaluatorFn;
};

export class AIListenerTrigger implements StartTrigger {
  readonly triggerType = AI_LISTENER_TRIGGER_TYPE;
  readonly defaultInitialPolicy = 'skip-existing' as const;

  private customCallTool: ToolCallerFn | null;
  private customEvaluate: EvaluatorFn | null;

  constructor(options?: AIListenerTriggerOptions) {
    this.customCallTool = options?.callTool ?? null;
    this.customEvaluate = options?.evaluate ?? null;
  }

  setCallTool(fn: ToolCallerFn | null): void {
    this.customCallTool = fn;
  }

  setEvaluate(fn: EvaluatorFn | null): void {
    this.customEvaluate = fn;
  }

  claimFromBpmn(event: BpmnStartEventView): BpmnClaim | null {
    const fromMessage = event.messageAttrs?.['tri:connectorType'];
    const fromSelf = event.selfAttrs['tri:connectorType'];
    const source =
      fromMessage === AI_LISTENER_TRIGGER_TYPE
        ? event.messageAttrs!
        : fromSelf === AI_LISTENER_TRIGGER_TYPE
        ? event.selfAttrs
        : null;
    if (!source) return null;
    return { config: stripTriPrefix(source, ['connectorType']) };
  }

  validate(def: TriggerDefinition): void {
    const cfg = def.config;
    if (!asString(cfg['toolEndpoint'])) {
      throw new Error('ai-listener trigger requires tri:toolEndpoint');
    }
    if (!asString(cfg['tool'])) {
      throw new Error('ai-listener trigger requires tri:tool');
    }
    if (!asString(cfg['prompt'])) {
      throw new Error('ai-listener trigger requires tri:prompt');
    }
    // llmEndpoint is only required when no evaluator override is wired in.
    if (this.customEvaluate === null && !asString(cfg['llmEndpoint'])) {
      throw new Error(
        'ai-listener trigger requires tri:llmEndpoint (or inject an evaluator via AIListenerTrigger constructor)',
      );
    }
    const pollSeconds = parsePoll(cfg['pollIntervalSeconds']);
    if (pollSeconds < MIN_POLL_SECONDS) {
      throw new Error(
        `ai-listener tri:pollIntervalSeconds must be >= ${MIN_POLL_SECONDS} (got ${pollSeconds})`,
      );
    }
  }

  nextSchedule(
    def: TriggerDefinition,
    _lastFiredAt: Date | null,
    _cursor: TriggerCursor,
  ): TriggerSchedule {
    return { kind: 'interval', ms: parsePoll(def.config['pollIntervalSeconds']) * 1000 };
  }

  async fire(invocation: TriggerInvocation): Promise<TriggerResult> {
    const cfg = invocation.definition.config;
    const toolEndpoint = asString(cfg['toolEndpoint'])!;
    const tool = asString(cfg['tool'])!;
    const prompt = asString(cfg['prompt'])!;
    const llmEndpoint = asString(cfg['llmEndpoint']);

    const toolResult = this.customCallTool
      ? await this.customCallTool(tool, toolEndpoint, invocation.credentials)
      : await defaultCallTool(toolEndpoint, tool, invocation.credentials ?? undefined);

    let evaluation: EvaluationResult;
    if (this.customEvaluate) {
      evaluation = await this.customEvaluate(prompt, toolResult, invocation.credentials);
    } else {
      if (!llmEndpoint) {
        throw new Error('ai-listener: no llmEndpoint configured and no evaluator override set');
      }
      evaluation = await defaultEvaluateWithLlm(
        llmEndpoint,
        prompt,
        toolResult,
        invocation.credentials ?? undefined,
      );
    }

    if (evaluation.decision !== 'yes') {
      return { starts: [], nextCursor: invocation.cursor };
    }

    const dedupKey = evaluation.correlationId ?? fingerprint(toolResult);

    return {
      starts: [
        {
          dedupKey,
          payload: {
            aiListener: {
              tool,
              prompt,
              detectedAt: invocation.now.toISOString(),
              decision: evaluation.decision,
              reason: evaluation.reason ?? null,
              toolResult,
            },
          },
        },
      ],
      nextCursor: invocation.cursor,
    };
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function parsePoll(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_POLL_SECONDS;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16);
}
