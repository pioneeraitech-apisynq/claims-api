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

/** Status codes that warrant a retry with back-off. */
const RETRYABLE_STATUS_CODES = new Set([429, 503]);

/** Maximum number of attempts (1 initial + 3 retries). */
const MAX_ATTEMPTS = 4;

/** Base delay in milliseconds used for exponential back-off. */
const BASE_BACKOFF_MS = 1_000;

/**
 * Wraps generateObject with Retry-After-aware exponential back-off.
 *
 * On a 429 (rate limit / slow_down) or 503 (server_is_overloaded) response the
 * handler first inspects the `Retry-After` header and waits at least as long as
 * it specifies. When the header is absent it falls back to exponential back-off
 * (1 s, 2 s, 4 s …). The Vercel AI SDK's own retry loop is disabled
 * (maxRetries: 0) so that only this handler controls retry behaviour.
 */
async function generateObjectWithBackoff(
  params: Parameters<typeof generateObject>[0],
): Promise<Awaited<ReturnType<typeof generateObject>>> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      // maxRetries: 0 disables the SDK's built-in retry so ours is in full
      // control.
      return await generateObject({ ...params, maxRetries: 0 });
    } catch (err: unknown) {
      lastError = err;

      // Extract HTTP status and headers from the error when available.
      const status: number | undefined =
        (err as { status?: number })?.status ??
        (err as { statusCode?: number })?.statusCode;

      const headers: Record<string, string> | undefined =
        (err as { responseHeaders?: Record<string, string> })?.responseHeaders ??
        (err as { headers?: Record<string, string> })?.headers;

      const isRetryable =
        status !== undefined && RETRYABLE_STATUS_CODES.has(status);

      // Non-retryable errors (auth failures, validation errors, …) bubble up
      // immediately.
      if (!isRetryable) {
        throw err;
      }

      // Don't wait after the last attempt.
      if (attempt === MAX_ATTEMPTS - 1) {
        break;
      }

      // Honour the Retry-After header if present; fall back to exponential
      // back-off otherwise.
      let delayMs: number;
      const retryAfterRaw =
        headers?.['retry-after'] ?? headers?.['Retry-After'];

      if (retryAfterRaw !== undefined) {
        const retryAfterSeconds = parseFloat(retryAfterRaw);
        delayMs = isNaN(retryAfterSeconds)
          ? BASE_BACKOFF_MS * Math.pow(2, attempt)
          : retryAfterSeconds * 1_000;
      } else {
        delayMs = BASE_BACKOFF_MS * Math.pow(2, attempt);
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
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
