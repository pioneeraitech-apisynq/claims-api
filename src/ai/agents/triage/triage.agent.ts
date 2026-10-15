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

// ---------------------------------------------------------------------------
// Retry helper — 429 / 503 aware with Retry-After + exponential backoff
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS_CODES = new Set([429, 503]);
const MAX_RETRY_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

/**
 * Parses the `Retry-After` header value into milliseconds.
 * Accepts both delay-seconds (e.g. "2") and HTTP-date formats.
 * Returns `undefined` when the header is absent or unparseable.
 */
function parseRetryAfterMs(retryAfter: string | undefined): number | undefined {
  if (!retryAfter) return undefined;
  const delaySeconds = Number(retryAfter);
  if (Number.isFinite(delaySeconds) && delaySeconds >= 0) {
    return delaySeconds * 1000;
  }
  const date = new Date(retryAfter);
  if (!Number.isNaN(date.getTime())) {
    const ms = date.getTime() - Date.now();
    return ms > 0 ? ms : 0;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes `fn`, retrying on HTTP 429 / 503 responses up to
 * MAX_RETRY_ATTEMPTS times. On each retryable error the wrapper honours the
 * `Retry-After` response header when present; otherwise it falls back to
 * exponential backoff with jitter.
 */
async function withOpenAIRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      attempt += 1;

      // Extract status code and Retry-After from the error object.
      // The Vercel AI SDK surfaces HTTP errors as plain objects / APIError
      // instances that carry `status` and `responseHeaders`.
      const status: number | undefined = (err as Record<string, unknown>)
        ?.status as number | undefined;
      const headers = (err as Record<string, unknown>)
        ?.responseHeaders as Record<string, string> | undefined;
      const retryAfterHeader: string | undefined =
        headers?.['retry-after'] ?? headers?.['Retry-After'];

      const isRetryable =
        typeof status === 'number' && RETRYABLE_STATUS_CODES.has(status);

      if (!isRetryable || attempt >= MAX_RETRY_ATTEMPTS) {
        throw err;
      }

      const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
      const exponentialMs = Math.min(
        BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * BASE_BACKOFF_MS,
        MAX_BACKOFF_MS,
      );
      const waitMs = retryAfterMs !== undefined ? retryAfterMs : exponentialMs;

      await sleep(waitMs);
    }
  }
}

// ---------------------------------------------------------------------------
// Schema & types
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

  const { object } = await withOpenAIRetry(() =>
    generateObject({
      model: openai(TRIAGE_MODEL),
      schema: triageResultSchema,
      system: TRIAGE_SYSTEM_PROMPT,
      prompt: buildTriagePrompt(promptInput),
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
