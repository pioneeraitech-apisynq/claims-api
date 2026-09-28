import { generateObject } from 'ai';
import { z } from 'zod';
import { TRIAGE_MODEL, resolveModel } from '../../openai.provider';
import { searchPolicyWording } from '../../retrieval/policy-wording.retriever';
import {
  TRIAGE_SYSTEM_PROMPT,
  buildTriagePrompt,
  type TriagePromptInput,
} from './triage.prompt';

/**
 * Claim triage agent.
 *
 * Runs OpenAI gpt-4o-mini through the Vercel AI SDK with a zod-constrained
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

// ---------------------------------------------------------------------------
// Retry helper — Retry-After-aware exponential back-off
// ---------------------------------------------------------------------------

/**
 * Maximum number of attempts (1 initial + 4 retries) before giving up.
 * Kept conservative: the goal is to survive transient 429 / 503 bursts without
 * hammering the API during a sustained overload window.
 */
const MAX_ATTEMPTS = 5;

/** Base delay for exponential back-off when no Retry-After header is present. */
const BASE_DELAY_MS = 500;

/** Cap individual waits at 32 s so a runaway back-off cannot stall a claim. */
const MAX_DELAY_MS = 32_000;

/**
 * Status codes that are safe to retry.
 *  429 — rate-limited / slow_down
 *  503 — server_is_overloaded
 */
const RETRYABLE_STATUS_CODES = new Set([429, 503]);

/**
 * Extracts the number of milliseconds to wait from an error thrown by the
 * Vercel AI SDK.
 *
 * The SDK surfaces HTTP metadata on the caught error object as `statusCode`
 * and `responseHeaders` (both present on `APICallError` in ai@4.x).  We
 * intentionally use duck-typing rather than an instanceof check so the helper
 * stays robust across minor SDK version changes.
 *
 * Resolution order:
 *  1. `Retry-After` header value in seconds (RFC 7231 delta-seconds form).
 *  2. `Retry-After` header value as an HTTP-date.
 *  3. Exponential back-off: BASE_DELAY_MS × 2^attempt, jittered ±10 %.
 */
function resolveDelayMs(err: unknown, attempt: number): number | null {
  if (
    typeof err !== 'object' ||
    err === null ||
    !('statusCode' in err) ||
    !RETRYABLE_STATUS_CODES.has((err as { statusCode: number }).statusCode)
  ) {
    return null; // not retryable
  }

  // Try to read the Retry-After header.
  const headers = (err as { responseHeaders?: Record<string, string> })
    .responseHeaders;
  const retryAfter = headers?.['retry-after'] ?? headers?.['Retry-After'];

  if (retryAfter) {
    const deltaSeconds = Number(retryAfter);
    if (!isNaN(deltaSeconds) && deltaSeconds >= 0) {
      // delta-seconds form (most common for OpenAI)
      return Math.min(deltaSeconds * 1_000, MAX_DELAY_MS);
    }

    // HTTP-date form (e.g. "Wed, 21 Oct 2025 07:28:00 GMT")
    const retryDate = new Date(retryAfter);
    if (!isNaN(retryDate.getTime())) {
      const waitMs = retryDate.getTime() - Date.now();
      return Math.min(Math.max(waitMs, 0), MAX_DELAY_MS);
    }
  }

  // No usable Retry-After — fall back to exponential back-off with ±10 % jitter.
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = exponential * 0.1 * (Math.random() * 2 - 1);
  return Math.min(Math.round(exponential + jitter), MAX_DELAY_MS);
}

/**
 * Calls `fn` and retries on retryable OpenAI errors (429 / 503), honouring
 * the `Retry-After` response header and falling back to exponential back-off.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const delayMs = resolveDelayMs(err, attempt);

      if (delayMs === null) {
        // Non-retryable error — surface it immediately.
        throw err;
      }

      lastError = err;

      // Log so the delay is visible in traces without crashing the service.
      console.warn(
        `[triage.agent] OpenAI retryable error on attempt ${attempt + 1}/${MAX_ATTEMPTS}. ` +
          `Waiting ${delayMs} ms before retry.`,
        { statusCode: (err as { statusCode?: number }).statusCode },
      );

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Agent entry point
// ---------------------------------------------------------------------------

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

  const model = await resolveModel(TRIAGE_MODEL);

  const { object } = await withRetry(() =>
    generateObject({
      model,
      schema: triageResultSchema,
      system: TRIAGE_SYSTEM_PROMPT,
      prompt: buildTriagePrompt(promptInput),
      temperature: 0.1,
      // maxRetries is intentionally omitted: the SDK's built-in fixed-count
      // retry does not read Retry-After or apply exponential back-off.
      // withRetry() above handles all retry logic correctly.
      maxRetries: 0,
    }),
  );

  // The model is asked not to exceed the coverage limit; enforce it anyway so a
  // bad generation can never book an over-limit payout.
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
}
