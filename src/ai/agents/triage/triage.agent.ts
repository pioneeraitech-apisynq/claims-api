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

/**
 * Maximum number of attempts (1 initial + up to 3 retries) for transient
 * OpenAI errors.
 */
const MAX_ATTEMPTS = 4;

/**
 * Base delay (ms) used for exponential back-off when no Retry-After header is
 * present.  Doubles on every subsequent attempt: 1 s, 2 s, 4 s, …
 */
const BASE_BACKOFF_MS = 1_000;

/**
 * Resolves the number of milliseconds to wait before the next attempt.
 *
 * Priority order:
 *  1. `Retry-After` header value from the response (seconds or HTTP-date).
 *  2. Exponential back-off based on how many attempts have already been made.
 *
 * @param retryAfterHeader - Raw value of the `Retry-After` response header, or
 *                           null/undefined when absent.
 * @param attemptsMade     - Number of attempts already completed (≥ 1).
 */
function resolveDelayMs(
  retryAfterHeader: string | null | undefined,
  attemptsMade: number,
): number {
  if (retryAfterHeader) {
    // Retry-After can be a delta-seconds integer or an HTTP-date string.
    const deltaSeconds = Number(retryAfterHeader);
    if (!Number.isNaN(deltaSeconds) && deltaSeconds >= 0) {
      return Math.ceil(deltaSeconds * 1_000);
    }
    const httpDate = Date.parse(retryAfterHeader);
    if (!Number.isNaN(httpDate)) {
      const waitMs = httpDate - Date.now();
      if (waitMs > 0) return waitMs;
    }
  }
  // Fall back to exponential back-off (capped at 30 s).
  return Math.min(BASE_BACKOFF_MS * 2 ** (attemptsMade - 1), 30_000);
}

/**
 * Extracts structured error metadata from an error thrown by the Vercel AI SDK
 * / OpenAI SDK.  Returns null when the error is not a retryable HTTP error.
 */
function extractRetryInfo(err: unknown): {
  status: number;
  retryAfter: string | null | undefined;
} | null {
  if (err == null || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;

  // The AI SDK wraps HTTP errors in an object with a `status` (or `statusCode`)
  // field and optionally a `responseHeaders` map or a `headers` map.
  const status =
    typeof e['status'] === 'number'
      ? e['status']
      : typeof e['statusCode'] === 'number'
        ? e['statusCode']
        : null;

  if (status !== 429 && status !== 503) return null;

  // Try the most common header carrier shapes exposed by the SDK.
  const headers =
    (e['responseHeaders'] as Record<string, string> | undefined) ??
    (e['headers'] as Record<string, string> | undefined) ??
    {};

  const retryAfter =
    headers['retry-after'] ?? headers['Retry-After'] ?? null;

  return { status, retryAfter };
}

/**
 * Runs `fn` and retries up to (MAX_ATTEMPTS - 1) times when OpenAI responds
 * with a 429 (slow_down / rate-limit) or 503 (server_is_overloaded).
 *
 * - Respects the `Retry-After` header when present.
 * - Falls back to exponential back-off otherwise.
 * - Any other error is rethrown immediately without consuming retry budget.
 */
async function withOpenAIRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (err: unknown) {
      const retryInfo = extractRetryInfo(err);

      // Non-retryable error — propagate immediately.
      if (retryInfo === null) throw err;

      const { status, retryAfter } = retryInfo;
      const errorKind =
        status === 429 ? 'slow_down (429)' : 'server_is_overloaded (503)';

      if (attempt >= MAX_ATTEMPTS) {
        // Exhausted all retries — surface the original error.
        throw err;
      }

      const delayMs = resolveDelayMs(retryAfter, attempt);
      console.warn(
        `OpenAI ${errorKind} on attempt ${attempt}/${MAX_ATTEMPTS}. ` +
          `Waiting ${delayMs} ms before retry.`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
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

  const { object } = await withOpenAIRetry(() =>
    generateObject({
      model: openai(TRIAGE_MODEL),
      schema: triageResultSchema,
      system: TRIAGE_SYSTEM_PROMPT,
      prompt: buildTriagePrompt(promptInput),
      // temperature and top_p are not supported by GPT-6 Astra and must be
      // omitted. See finding #3.
      maxRetries: 0, // retries are handled by withOpenAIRetry above
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
