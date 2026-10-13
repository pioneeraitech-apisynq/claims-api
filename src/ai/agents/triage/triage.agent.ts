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
 * Runs OpenAI GPT-6 Astra through the Vercel AI SDK using the Responses API
 * (required for tool/structured-output calls on GPT-6 Astra). Before the model
 * is called, the claim narrative is used to retrieve the relevant policy wording
 * clauses from Pinecone, so the agent quotes real wording instead of
 * paraphrasing from memory.
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
 * Retry wrapper that honours the `Retry-After` header on 429 / 503 responses
 * from the OpenAI API and falls back to exponential backoff when the header is
 * absent.  This replaces the SDK's built-in `maxRetries` option, which retries
 * immediately without inspecting `Retry-After`.
 */
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      attempt += 1;
      if (attempt > MAX_RETRIES) throw err;

      // The Vercel AI SDK surfaces response headers on API errors.
      const headers: Record<string, string> =
        (err as { responseHeaders?: Record<string, string> })
          ?.responseHeaders ?? {};
      const retryAfterRaw = headers['retry-after'] ?? headers['Retry-After'];
      let delayMs: number;

      if (retryAfterRaw) {
        // Retry-After is either a delta-seconds integer or an HTTP-date.
        const deltaSeconds = Number(retryAfterRaw);
        if (!Number.isNaN(deltaSeconds) && deltaSeconds >= 0) {
          delayMs = deltaSeconds * 1_000;
        } else {
          const retryDate = new Date(retryAfterRaw).getTime();
          delayMs = Math.max(0, retryDate - Date.now());
        }
      } else {
        // Exponential backoff: 1 s, 2 s, 4 s, …
        delayMs = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
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

  // GPT-6 Astra requires the Responses API for structured-output / tool calls.
  // temperature and top_p are not supported by GPT-6 Astra and are omitted.
  const { object } = await withRetry(() =>
    generateObject({
      model: openai.responses(TRIAGE_MODEL),
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
