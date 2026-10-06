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

/** Status codes that OpenAI uses for rate-limit / overload responses. */
const RETRYABLE_STATUS_CODES = new Set([429, 503]);

/** Base delay in milliseconds for the first backoff interval (1 s, 2 s, 4 s …). */
const BACKOFF_BASE_MS = 1_000;

/**
 * Return the number of milliseconds to wait before the next attempt.
 *
 * Prefers the `Retry-After` header value when the provider supplies one
 * (OpenAI sends it on 429 `slow_down` and 503 `server_is_overloaded`).
 * Falls back to exponential backoff: attempt 0 → 1 s, 1 → 2 s, 2 → 4 s.
 */
function resolveDelayMs(error: unknown, attempt: number): number {
  if (error && typeof error === 'object') {
    // The Vercel AI SDK surfaces the raw response headers on APICallError.
    const headers = (error as Record<string, unknown>)['responseHeaders'];
    if (headers && typeof headers === 'object') {
      const retryAfter =
        (headers as Record<string, string>)['retry-after'] ??
        (headers as Record<string, string>)['Retry-After'];
      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds > 0) {
          return seconds * 1_000;
        }
      }
    }
  }
  return BACKOFF_BASE_MS * Math.pow(2, attempt);
}

/** True when the error represents a transient rate-limit or overload response. */
function isRetryable(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const status = (error as Record<string, unknown>)['statusCode'];
    if (typeof status === 'number') {
      return RETRYABLE_STATUS_CODES.has(status);
    }
  }
  return false;
}

/**
 * Thin wrapper around `generateObject` that adds Retry-After-aware exponential
 * backoff for rate-limit (429) and overload (503) errors.
 *
 * `maxRetries` is set to 0 on the SDK call so that errors surface immediately
 * to this wrapper rather than being silently retried without any delay.
 */
async function generateObjectWithBackoff(
  params: Parameters<typeof generateObject>[0],
  maxAttempts: number = 3,
): Promise<Awaited<ReturnType<typeof generateObject>>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await generateObject({ ...params, maxRetries: 0 });
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt || !isRetryable(err)) {
        throw err;
      }
      const delayMs = resolveDelayMs(err, attempt);
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
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

  const { object } = await generateObjectWithBackoff({
    model: openai(TRIAGE_MODEL),
    schema: triageResultSchema,
    system: TRIAGE_SYSTEM_PROMPT,
    prompt: buildTriagePrompt(promptInput),
    temperature: 0.1,
  });

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
