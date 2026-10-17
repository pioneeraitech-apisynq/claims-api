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
 * Maximum number of attempts for a single triage call (initial + retries).
 */
const MAX_ATTEMPTS = 3;

/**
 * Base delay (ms) for exponential backoff when no Retry-After header is
 * present. Doubles on each subsequent attempt: 500 ms → 1 000 ms → 2 000 ms …
 */
const BASE_BACKOFF_MS = 500;

/**
 * Calls `fn` with exponential backoff and Retry-After awareness.
 *
 * On a 429 or 503 response the wrapper:
 *   1. Reads the `Retry-After` header (seconds or HTTP-date) and waits at
 *      least that long before retrying.
 *   2. Falls back to `BASE_BACKOFF_MS * 2^attempt` when the header is absent.
 *
 * All other errors are re-thrown immediately.
 */
async function withRetryAfterBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;

      // Extract status code and Retry-After from the error if the SDK surfaces
      // them. The Vercel AI SDK wraps HTTP errors with a `status` property and
      // optionally a `responseHeaders` map.
      const status: number | undefined =
        (err as Record<string, unknown>)?.['status'] as number | undefined;

      const isRetryable = status === 429 || status === 503;
      const isLastAttempt = attempt === MAX_ATTEMPTS - 1;

      if (!isRetryable || isLastAttempt) {
        throw err;
      }

      // Determine wait time from Retry-After, falling back to exponential backoff.
      const headers =
        (err as Record<string, unknown>)?.['responseHeaders'] as
          | Record<string, string>
          | undefined;
      const retryAfterRaw =
        headers?.['retry-after'] ?? headers?.['Retry-After'];

      let waitMs: number;
      if (retryAfterRaw !== undefined) {
        const retryAfterSeconds = Number(retryAfterRaw);
        if (!Number.isNaN(retryAfterSeconds)) {
          // Value is a delay in seconds.
          waitMs = retryAfterSeconds * 1_000;
        } else {
          // Value is an HTTP-date; compute delta from now.
          const retryDate = Date.parse(retryAfterRaw);
          waitMs = Number.isNaN(retryDate)
            ? BASE_BACKOFF_MS * 2 ** attempt
            : Math.max(0, retryDate - Date.now());
        }
      } else {
        waitMs = BASE_BACKOFF_MS * 2 ** attempt;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
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

  // `temperature` is intentionally omitted: GPT-6 Astra does not support
  // custom temperature or top_p values and will return an API error if they
  // are supplied (finding #4).
  //
  // `maxRetries` is removed in favour of the custom `withRetryAfterBackoff`
  // wrapper above, which honours the Retry-After header and applies
  // exponential backoff (finding #1).
  const { object } = await withRetryAfterBackoff(() =>
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
