import { generateObject } from 'ai';
import { z } from 'zod';
import { TRIAGE_MODEL, openai } from '../../openai.provider';
import { searchPolicyWording } from '../../retrieval/policy-wording.retriever';
import {
  TRIAGE_SYSTEM_PROMPT,
  buildTriagePrompt,
  type TriagePromptInput,
} from './triage.prompt';

/**
 * Claim triage agent.
 *
 * Runs OpenAI gpt-6-astra through the Vercel AI SDK with a zod-constrained
 * result. Before the model is called, the claim narrative is used to retrieve
 * the relevant policy wording clauses from Pinecone, so the agent quotes real
 * wording instead of paraphrasing from memory.
 */

export const triageResultSchema = z.object({
  recommendation: z
    .enum(['fast_track', 'standard_review', 'adjuster_review', 'decline'])
    .describe('Recommended handling route for this claim'),
  severity: z
    .enum(['minor', 'moderate', 'major', 'catastrophic'])
    .describe('Severity of the loss as described in the narrative'),
  coveredUnderPolicy: z
    .boolean()
    .describe('Whether the retrieved wording covers the described loss'),
  citedClauseId: z
    .string()
    .nullable()
    .describe('Id of the retrieved clause the recommendation rests on'),
  quotedClause: z
    .string()
    .nullable()
    .describe('The cited clause quoted verbatim'),
  recommendedPayoutCents: z
    .number()
    .int()
    .min(0)
    .describe('Recommended payout, never above the coverage limit'),
  fraudIndicators: z
    .array(z.string())
    .describe('Concrete fraud signals found in the narrative, dates or amounts'),
  requiresHumanAdjuster: z
    .boolean()
    .describe('True when a human adjuster must review before any payout'),
  missingInformation: z
    .array(z.string())
    .describe('Facts or documents needed before the claim can be decided'),
  rationale: z
    .string()
    .max(1200)
    .describe('Short explanation of the recommendation for the adjuster'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('Model confidence in the recommendation'),
});

export type TriageResult = z.infer<typeof triageResultSchema>;

export interface TriageAgentInput
  extends Omit<TriagePromptInput, 'clauses' | 'fastTrackThresholdCents'> {
  fastTrackThresholdCents?: number;
}

export interface TriageAgentOutput extends TriageResult {
  model: string;
  retrievedClauseIds: string[];
}

const DEFAULT_FAST_TRACK_THRESHOLD_CENTS = 250_000;

/** Maximum number of attempts (1 initial + 3 retries). */
const MAX_ATTEMPTS = 4;

/** Status codes that warrant a retry with backoff. */
const RETRYABLE_STATUS_CODES = new Set([429, 503]);

/**
 * Parse the `Retry-After` response header into milliseconds.
 * Supports both the delay-seconds form (e.g. "30") and the
 * HTTP-date form (e.g. "Wed, 21 Oct 2025 07:28:00 GMT").
 * Returns `null` when the header is absent or unparseable.
 */
function parseRetryAfterMs(headers: Headers): number | null {
  const raw = headers.get('retry-after') ?? headers.get('Retry-After');
  if (!raw) return null;

  const seconds = Number(raw);
  if (!Number.isNaN(seconds)) return seconds * 1000;

  const date = new Date(raw).getTime();
  if (!Number.isNaN(date)) {
    const ms = date - Date.now();
    return ms > 0 ? ms : null;
  }

  return null;
}

/**
 * Return how long to wait (ms) before the nth retry attempt (0-based index).
 * Honours `Retry-After` when present; otherwise uses capped exponential backoff
 * with full jitter: random in [0, min(cap, base * 2^attempt)].
 */
function backoffMs(attempt: number, headers?: Headers): number {
  if (headers) {
    const retryAfter = parseRetryAfterMs(headers);
    if (retryAfter !== null) return retryAfter;
  }

  const BASE_MS = 500;
  const CAP_MS = 30_000;
  const ceiling = Math.min(CAP_MS, BASE_MS * 2 ** attempt);
  return Math.random() * ceiling;
}

/** Resolves after `ms` milliseconds. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Extract the HTTP status code from an error thrown by the Vercel AI SDK.
 * The SDK surfaces the raw response in `error.response` (a standard `Response`
 * object) when available, and also sets `error.status` on some error classes.
 */
function extractStatus(err: unknown): { status: number; headers: Headers } | null {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;

    // Vercel AI SDK wraps the raw fetch Response in `error.response`
    if (e['response'] && typeof e['response'] === 'object') {
      const res = e['response'] as { status?: unknown; headers?: unknown };
      if (typeof res.status === 'number' && res.headers instanceof Headers) {
        return { status: res.status, headers: res.headers };
      }
    }

    // Fallback: some SDK error classes expose `status` directly
    if (typeof e['status'] === 'number') {
      return { status: e['status'], headers: new Headers() };
    }
  }
  return null;
}

export async function runTriageAgent(
  input: TriageAgentInput,
): Promise<TriageAgentOutput> {
  const clauses = await searchPolicyWording(
    input.incidentNarrative,
    input.productType,
  );

  const promptInput: TriagePromptInput = {
    ...input,
    fastTrackThresholdCents:
      input.fastTrackThresholdCents ?? DEFAULT_FAST_TRACK_THRESHOLD_CENTS,
    clauses,
  };

  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      // NOTE: `temperature` is intentionally omitted — GPT-6 Astra does not
      // support custom temperature or top_p values.
      const { object } = await generateObject({
        model: openai(TRIAGE_MODEL),
        schema: triageResultSchema,
        system: TRIAGE_SYSTEM_PROMPT,
        prompt: buildTriagePrompt(promptInput),
        // Disable the SDK's own blind retry loop; we handle retries ourselves
        // so we can inspect Retry-After headers and apply proper backoff.
        maxRetries: 0,
      });

      // The model is asked not to exceed the coverage limit; enforce it anyway
      // so a bad generation can never book an over-limit payout.
      const recommendedPayoutCents = Math.min(
        object.recommendedPayoutCents,
        input.coverageAmountCents,
      );

      return {
        ...object,
        recommendedPayoutCents,
        model: TRIAGE_MODEL,
        retrievedClauseIds: clauses.map((clause) => clause.clauseId),
      };
    } catch (err: unknown) {
      lastError = err;

      const info = extractStatus(err);
      const isRetryable = info !== null && RETRYABLE_STATUS_CODES.has(info.status);

      if (!isRetryable || attempt === MAX_ATTEMPTS - 1) {
        // Non-retryable error, or we've exhausted all attempts.
        throw err;
      }

      const delay = backoffMs(attempt, info?.headers);
      await sleep(delay);
    }
  }

  // Should be unreachable, but satisfies TypeScript's control-flow analysis.
  throw lastError;
}
