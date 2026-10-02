import { generateObject } from 'ai';
import { z } from 'zod';
import { TRIAGE_MODEL, openai, withOpenAIRetry } from '../../openai.provider';
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
// gpt-6-astra guard
// ---------------------------------------------------------------------------
// GPT-6 Astra does not support tool calling / structured output through the
// Chat Completions endpoint (which is what generateObject uses via the
// @ai-sdk/openai adapter). Bumping TRIAGE_MODEL to 'gpt-6-astra' without also
// migrating to the OpenAI Responses API would silently break every triage run.
// This guard converts that silent breakage into an immediate startup error so
// the misconfiguration cannot reach production.
if (TRIAGE_MODEL === 'gpt-6-astra') {
  throw new Error(
    'TRIAGE_MODEL is set to gpt-6-astra, but triage.agent.ts still uses ' +
      'generateObject which routes through the Chat Completions endpoint. ' +
      'GPT-6 Astra requires the Responses API for all tool/structured-output ' +
      'calls. Migrate triage.agent.ts to the Responses API before upgrading ' +
      'the model. See the OpenAI Responses migration guide.',
  );
}

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

  // withOpenAIRetry handles 429 / 503 responses: it honours the Retry-After
  // header when present and falls back to full-jitter exponential backoff when
  // it is absent. maxRetries is set to 0 so the SDK does not also retry
  // (retrying would bypass the backoff logic entirely).
  const { object } = await withOpenAIRetry(() =>
    generateObject({
      model: openai(TRIAGE_MODEL),
      schema: triageResultSchema,
      system: TRIAGE_SYSTEM_PROMPT,
      prompt: buildTriagePrompt(promptInput),
      // temperature is intentionally omitted: GPT-6 Astra rejects it, and
      // the default (1.0) is appropriate for deterministic structured output.
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
