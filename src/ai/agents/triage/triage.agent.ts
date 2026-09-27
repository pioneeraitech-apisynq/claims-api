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

/**
 * Retry configuration that satisfies the OpenAI rate-limit best practice:
 *  - Up to MAX_ATTEMPTS total attempts (1 original + MAX_ATTEMPTS-1 retries).
 *  - On 429 / 503 the response `Retry-After` header is honoured when present.
 *  - When the header is absent, full jitter exponential backoff is used:
 *      delay = random(0, min(BASE_DELAY_MS * 2^attempt, MAX_DELAY_MS))
 */
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

/** HTTP status codes that warrant a retry with back-off. */
const RETRYABLE_STATUSES = new Set([429, 503]);

function isRetryableError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  // The Vercel AI SDK surfaces rate-limit / overload errors as objects that
  // carry a `statusCode` or `status` property.
  const status =
    (err as Record<string, unknown>)['statusCode'] ??
    (err as Record<string, unknown>)['status'];
  return typeof status === 'number' && RETRYABLE_STATUSES.has(status);
}

/**
 * Extract a wait duration (ms) from a `Retry-After` header value if one is
 * present on the error. The header may be an integer number of seconds or an
 * HTTP-date string.
 */
function retryAfterMs(err: unknown): number | null {
  if (err == null || typeof err !== 'object') return null;
  const headers =
    (err as Record<string, unknown>)['responseHeaders'] ??
    (err as Record<string, unknown>)['headers'];
  if (headers == null || typeof headers !== 'object') return null;

  const raw =
    (headers as Record<string, unknown>)['retry-after'] ??
    (headers as Record<string, unknown>)['Retry-After'];
  if (raw == null) return null;

  const value = String(raw).trim();
  // Integer seconds
  if (/^\d+$/.test(value)) {
    return parseInt(value, 10) * 1000;
  }
  // HTTP-date
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }
  return null;
}

function exponentialBackoffMs(attempt: number): number {
  const ceiling = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
  // Full jitter: avoids thundering-herd on simultaneous retries.
  return Math.random() * ceiling;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps an async factory function with retry logic that respects `Retry-After`
 * and falls back to exponential backoff for retryable OpenAI errors.
 */
async function withOpenAIRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableError(err) || attempt === MAX_ATTEMPTS - 1) {
        throw err;
      }
      lastError = err;
      const waitMs = retryAfterMs(err) ?? exponentialBackoffMs(attempt);
      await sleep(waitMs);
    }
  }
  // Unreachable, but satisfies the TypeScript compiler.
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

  // maxRetries is set to 0 so the SDK does not issue its own uncontrolled
  // fixed-interval retries on top of the withOpenAIRetry wrapper above.
  const { object } = await withOpenAIRetry(() =>
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
