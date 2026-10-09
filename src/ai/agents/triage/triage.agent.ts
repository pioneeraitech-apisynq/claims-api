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
 * Runs OpenAI gpt-6-astra through the Vercel AI SDK's Responses API with a
 * zod-constrained result. Before the model is called, the claim narrative is
 * used to retrieve the relevant policy wording clauses from Pinecone, so the
 * agent quotes real wording instead of paraphrasing from memory.
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

/** Maximum number of attempts (1 initial + retries). */
const MAX_ATTEMPTS = 3;

/**
 * Parse the `Retry-After` response header and return the number of
 * milliseconds to wait. Accepts both the HTTP-date form and the
 * delta-seconds form; falls back to `fallbackMs` when absent or unparseable.
 */
function parseRetryAfterMs(
  headers: Record<string, string> | undefined,
  fallbackMs: number,
): number {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (!raw) return fallbackMs;
  const seconds = Number(raw);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return fallbackMs;
}

/**
 * Call `generateObject` against the Responses API with Retry-After-aware
 * exponential backoff on 429 (rate-limit) and 503 (overloaded) errors.
 *
 * Findings addressed:
 *  - Finding 2: honour `Retry-After` header; fall back to exponential backoff.
 *  - Finding 3: `temperature` is omitted — gpt-6-astra does not support it.
 *  - Finding 4: `openai.responses()` routes the call through the Responses API
 *               instead of Chat Completions, as required for GPT-6 Astra tool /
 *               schema-constrained calling.
 */
async function generateTriageObject(
  params: Omit<Parameters<typeof generateObject>[0], 'model'>,
) {
  let attempt = 0;
  let baseBackoffMs = 1_000;

  while (true) {
    attempt += 1;
    try {
      return await generateObject({
        model: openai.responses(TRIAGE_MODEL),
        ...params,
      });
    } catch (err: unknown) {
      const isRetryable =
        err instanceof Error &&
        /429|503|rate.?limit|slow.?down|overload/i.test(err.message);

      if (!isRetryable || attempt >= MAX_ATTEMPTS) throw err;

      // Prefer the Retry-After header when available; otherwise double the
      // base backoff (capped at 30 s) and add ±20 % jitter.
      const headers =
        err instanceof Error &&
        'responseHeaders' in err &&
        typeof (err as { responseHeaders?: unknown }).responseHeaders ===
          'object'
          ? ((err as { responseHeaders: Record<string, string> })
              .responseHeaders ?? undefined)
          : undefined;

      const retryAfterMs = parseRetryAfterMs(headers, baseBackoffMs);
      const jitter = retryAfterMs * 0.2 * (Math.random() * 2 - 1);
      const waitMs = Math.max(0, retryAfterMs + jitter);

      await new Promise((resolve) => setTimeout(resolve, waitMs));

      // Grow the base backoff for subsequent fallback calculations.
      baseBackoffMs = Math.min(baseBackoffMs * 2, 30_000);
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

  const { object } = await generateTriageObject({
    schema: triageResultSchema,
    system: TRIAGE_SYSTEM_PROMPT,
    prompt: buildTriagePrompt(promptInput),
    // temperature is intentionally omitted: gpt-6-astra does not support it.
    // maxRetries is set to 0 because generateTriageObject handles retries itself.
    maxRetries: 0,
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
