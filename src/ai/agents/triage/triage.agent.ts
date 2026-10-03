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

// ---------------------------------------------------------------------------
// Retry-After / exponential-backoff helper
//
// OpenAI returns 429 ("slow_down") when traffic is increasing too quickly and
// 503 ("server_is_overloaded") on temporary model overload. Both may include a
// Retry-After header. When present we wait at least as long as specified before
// retrying; when absent we fall back to exponential backoff with full jitter.
// ---------------------------------------------------------------------------

const RETRYABLE_STATUSES = new Set([429, 503]);
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;

function retryAfterMs(error: unknown): number | null {
  if (error === null || typeof error !== 'object') return null;
  const headers = (error as Record<string, unknown>)['responseHeaders'];
  if (!headers) return null;

  let value: string | null = null;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    value = (headers as Headers).get('retry-after');
  } else if (
    typeof (headers as Record<string, unknown>)['retry-after'] === 'string'
  ) {
    value = (headers as Record<string, string>)['retry-after'];
  }

  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds) * 1_000;
  }

  const target = Date.parse(value);
  if (!Number.isNaN(target)) {
    return Math.max(0, target - Date.now());
  }

  return null;
}

function isRetryable(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const status = (error as Record<string, unknown>)['statusCode'];
  return typeof status === 'number' && RETRYABLE_STATUSES.has(status);
}

function exponentialBackoffMs(attempt: number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.random() * ceiling;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetryAfterBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryable(error) || attempt >= maxRetries) {
        throw error;
      }
      const waitMs = retryAfterMs(error) ?? exponentialBackoffMs(attempt);
      await sleep(waitMs);
      attempt++;
    }
  }
}

// ---------------------------------------------------------------------------

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

  const { object } = await withRetryAfterBackoff(() =>
    generateObject({
      model: openai(TRIAGE_MODEL),
      schema: triageResultSchema,
      system: TRIAGE_SYSTEM_PROMPT,
      prompt: buildTriagePrompt(promptInput),
      temperature: 0.1,
      // maxRetries is intentionally omitted: our withRetryAfterBackoff wrapper
      // controls all retry timing so the SDK must not add blind retries of its
      // own on top.
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
