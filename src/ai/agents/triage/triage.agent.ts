import { generateObject, APICallError } from 'ai';
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

/**
 * Maximum number of attempts (initial call + retries) for transient OpenAI
 * errors (429 rate-limit / 503 server overloaded).
 */
const MAX_ATTEMPTS = 4;

/**
 * Base delay (ms) for exponential backoff when no Retry-After header is
 * present. Actual delay for attempt n is `BASE_BACKOFF_MS * 2^n` plus a small
 * jitter, capped at 32 s.
 */
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 32_000;

/**
 * Wraps an async factory function in retry logic that honours the
 * `Retry-After` header returned by OpenAI on 429 and 503 responses. When the
 * header is absent, exponential backoff with full jitter is used instead.
 *
 * @param fn         Factory producing the promise to attempt.
 * @param maxAttempts Total attempts allowed (first call counts as attempt 1).
 */
async function withRetryAfterBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;

      // Only retry on OpenAI 429 (rate-limit) and 503 (server overloaded).
      const isRetryable =
        APICallError.isAPICallError(err) &&
        (err.statusCode === 429 || err.statusCode === 503);

      if (!isRetryable || attempt >= maxAttempts) {
        throw err;
      }

      // Honour Retry-After header when present (value is seconds).
      let delayMs: number | undefined;
      const retryAfterHeader =
        err.responseHeaders?.['retry-after'] ??
        err.responseHeaders?.['Retry-After'];

      if (retryAfterHeader !== undefined) {
        const retryAfterSeconds = Number(retryAfterHeader);
        if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
          // Add a small jitter (up to 200 ms) to avoid thundering-herd when
          // many workers receive the same Retry-After value simultaneously.
          delayMs = retryAfterSeconds * 1_000 + Math.random() * 200;
        }
      }

      // Fall back to exponential backoff with full jitter when the header is
      // absent or unparseable.
      if (delayMs === undefined) {
        const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
        delayMs = Math.random() * ceiling;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
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

  // maxRetries is set to 0 so the Vercel AI SDK does not perform its own
  // blind retries. All retry logic — including Retry-After header handling —
  // is managed by withRetryAfterBackoff above.
  const { object } = await withRetryAfterBackoff(() =>
    generateObject({
      model: openai(TRIAGE_MODEL),
      schema: triageResultSchema,
      system: TRIAGE_SYSTEM_PROMPT,
      prompt: buildTriagePrompt(promptInput),
      temperature: 0.1,
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
