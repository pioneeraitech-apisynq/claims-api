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
 * Maximum number of attempts (1 initial + N-1 retries) for a triage completion
 * call. Retries are only made on 429 / 503 responses.
 */
const MAX_ATTEMPTS = 3;

/**
 * Calls `fn` and retries on 429 / 503 errors using the `Retry-After` response
 * header when present, falling back to full-jitter exponential backoff.
 *
 * Status codes that warrant a retry (slow_down / server_is_overloaded) are
 * transient by nature; flat-immediate retries worsen rate-limit pressure, so
 * we always wait before each successive attempt.
 */
async function withRetryAfterBackoff<T>(fn: () => Promise<T>): Promise<T> {
  const RETRYABLE_STATUSES = new Set([429, 503]);
  const BASE_DELAY_MS = 1_000;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
      if (isLastAttempt) throw err;

      // Extract the HTTP status and Retry-After header from whatever shape the
      // Vercel AI SDK / fetch surfaces the error in.
      const status: number | undefined =
        (err as { status?: number })?.status ??
        (err as { statusCode?: number })?.statusCode;

      if (status === undefined || !RETRYABLE_STATUSES.has(status)) {
        throw err;
      }

      const retryAfterRaw: string | undefined =
        (err as { responseHeaders?: Record<string, string> })?.responseHeaders?.[
          'retry-after'
        ] ??
        (err as { headers?: Record<string, string> })?.headers?.['retry-after'];

      let delayMs: number;
      if (retryAfterRaw !== undefined) {
        // The header value is either a delay-in-seconds integer or an HTTP-date.
        const seconds = Number(retryAfterRaw);
        delayMs = Number.isFinite(seconds)
          ? seconds * 1_000
          : Math.max(0, new Date(retryAfterRaw).getTime() - Date.now());
      } else {
        // Full-jitter exponential backoff: random value in [0, base * 2^attempt).
        const cap = BASE_DELAY_MS * Math.pow(2, attempt);
        delayMs = Math.random() * cap;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Unreachable — TypeScript needs the explicit throw.
  throw new Error('withRetryAfterBackoff: exceeded max attempts');
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
