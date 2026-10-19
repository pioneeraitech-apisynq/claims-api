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
 * Maximum number of attempts (1 initial + 4 retries) for rate-limit /
 * overload errors.  Kept conservative so a runaway retry loop can never
 * occupy a worker for more than ~30 s in the worst case.
 */
const MAX_ATTEMPTS = 5;

/**
 * Calls `generateObject` with Retry-After-aware exponential backoff.
 *
 * On a 429 (rate_limit_exceeded / slow_down) or 503 (server_is_overloaded)
 * response the function:
 *   1. Reads the `Retry-After` header (seconds) if present.
 *   2. Falls back to exponential backoff (1 s × 2^attempt) when the header is
 *      absent or unparseable.
 *   3. Waits, then retries up to MAX_ATTEMPTS total attempts.
 *
 * All other errors are re-thrown immediately so the caller sees them without
 * delay.
 */
async function generateObjectWithBackoff(
  ...args: Parameters<typeof generateObject>
): Promise<Awaited<ReturnType<typeof generateObject>>> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      // generateObject is generic; the single spread covers all overloads.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (generateObject as any)(...args);
    } catch (err: unknown) {
      const isRetryable = isRateLimitOrOverload(err);

      if (!isRetryable || attempt === MAX_ATTEMPTS - 1) {
        throw err;
      }

      const delayMs = retryAfterMs(err, attempt);
      await sleep(delayMs);
    }
  }

  // Unreachable, but satisfies TypeScript's control-flow analysis.
  throw new Error('generateObjectWithBackoff: exhausted retries unexpectedly');
}

/** Returns true for HTTP 429 and 503 responses from the OpenAI SDK. */
function isRateLimitOrOverload(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as Record<string, unknown>)['status'] ??
    (err as Record<string, unknown>)['statusCode'];
  return status === 429 || status === 503;
}

/**
 * Extracts the wait duration in milliseconds from a failed response.
 *
 * Prefers the `Retry-After` header (an integer number of seconds).
 * Falls back to `2^attempt` seconds (1 s, 2 s, 4 s, 8 s, …) with a
 * ±10 % jitter to avoid thundering-herd problems.
 */
function retryAfterMs(err: unknown, attempt: number): number {
  if (err && typeof err === 'object') {
    // The Vercel AI SDK surfaces response headers on `responseHeaders`.
    const headers = (err as Record<string, unknown>)['responseHeaders'] as
      | Record<string, string>
      | undefined;
    const headerValue =
      headers?.['retry-after'] ?? headers?.['Retry-After'];
    if (headerValue) {
      const seconds = parseInt(headerValue, 10);
      if (!isNaN(seconds) && seconds > 0) {
        return seconds * 1_000;
      }
    }
  }

  // Exponential backoff: 1 s, 2 s, 4 s, 8 s, … capped at 32 s.
  const baseMs = Math.min(1_000 * Math.pow(2, attempt), 32_000);
  const jitter = baseMs * 0.1 * (Math.random() * 2 - 1); // ±10 %
  return Math.round(baseMs + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
