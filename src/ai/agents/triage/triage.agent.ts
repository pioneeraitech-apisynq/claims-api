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

/** Maximum number of attempts for a rate-limited or overloaded OpenAI call. */
const MAX_RETRIES = 4;
/** Base delay in ms for exponential backoff when no Retry-After header is present. */
const BASE_BACKOFF_MS = 1_000;

/**
 * Calls generateObject with Retry-After–aware exponential backoff.
 *
 * On 429 (rate limit / slow_down) or 503 (server_is_overloaded) responses the
 * SDK throws an error whose `responseHeaders` may contain a `retry-after`
 * value. We honour that delay when present; otherwise we fall back to
 * exponential backoff (1 s, 2 s, 4 s, …) with a small random jitter to
 * prevent thundering-herd behaviour across concurrent triage calls.
 */
async function generateObjectWithBackoff(
  params: Parameters<typeof generateObject>[0],
): Promise<Awaited<ReturnType<typeof generateObject>>> {
  let attempt = 0;
  while (true) {
    try {
      // maxRetries: 0 so the SDK does not add its own flat retry layer on top
      // of our backoff loop.
      return await generateObject({ ...params, maxRetries: 0 });
    } catch (err: unknown) {
      attempt += 1;
      if (attempt >= MAX_RETRIES) throw err;

      const status =
        (err as { status?: number })?.status ??
        (err as { statusCode?: number })?.statusCode;
      const isRateLimitOrOverload = status === 429 || status === 503;
      if (!isRateLimitOrOverload) throw err;

      // Respect the Retry-After header when the API provides one.
      const retryAfterHeader: string | undefined =
        (err as { responseHeaders?: Record<string, string> })
          ?.responseHeaders?.['retry-after'];
      const retryAfterMs = retryAfterHeader
        ? parseFloat(retryAfterHeader) * 1_000
        : BASE_BACKOFF_MS * Math.pow(2, attempt - 1);

      // Add ±10 % jitter to avoid correlated retries.
      const jitter = retryAfterMs * 0.1 * (Math.random() * 2 - 1);
      const delay = Math.max(0, retryAfterMs + jitter);

      await new Promise((resolve) => setTimeout(resolve, delay));
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

  // temperature is omitted: GPT-6 Astra does not support custom temperature
  // or top_p values. Backoff is handled by generateObjectWithBackoff above.
  const { object } = await generateObjectWithBackoff({
    model: openai(TRIAGE_MODEL),
    schema: triageResultSchema,
    system: TRIAGE_SYSTEM_PROMPT,
    prompt: buildTriagePrompt(promptInput),
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
