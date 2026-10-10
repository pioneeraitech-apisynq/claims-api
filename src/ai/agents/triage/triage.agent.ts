import { generateObject, wrapLanguageModel } from 'ai';
import type { LanguageModelMiddleware } from 'ai';
import { z } from 'zod';
import { TRIAGE_MODEL, openai } from '../../openai.provider';
import {
  searchPolicyWording,
  type PolicyClause,
} from '../../retrieval/policy-wording.retriever';
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
 *
 * The retrieval step is implemented as Language Model Middleware so it is
 * isolated from business logic, independently testable, and composable with
 * other middleware (e.g. guardrails).
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
 * Language Model Middleware that performs the RAG step for the triage agent.
 *
 * It intercepts the outgoing prompt, embeds the claim narrative, queries
 * Pinecone for the most relevant policy wording clauses, and rebuilds the
 * prompt with those clauses injected before forwarding the call to the
 * underlying model. The retrieved clause ids are stored on the middleware
 * instance so the agent can surface them in its output without re-querying.
 */
function createPolicyWordingRagMiddleware(
  incidentNarrative: string,
  productType: string,
  promptInputBase: Omit<TriagePromptInput, 'clauses'>,
): { middleware: LanguageModelMiddleware; getRetrievedClauses: () => PolicyClause[] } {
  let retrievedClauses: PolicyClause[] = [];

  const middleware: LanguageModelMiddleware = {
    async transformParams({ type, params }) {
      // Only intercept the first (and only) call; the prompt contains the
      // original user message produced by buildTriagePrompt without clauses.
      retrievedClauses = await searchPolicyWording(
        incidentNarrative,
        productType,
      );

      const promptInput: TriagePromptInput = {
        ...promptInputBase,
        clauses: retrievedClauses,
      };

      // Replace the prompt with the clause-enriched version.
      return {
        ...params,
        prompt: [
          {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: buildTriagePrompt(promptInput) }],
          },
        ],
      };
    },
  };

  return {
    middleware,
    getRetrievedClauses: () => retrievedClauses,
  };
}

export async function runTriageAgent(
  input: TriageAgentInput,
): Promise<TriageAgentOutput> {
  const fastTrackThresholdCents =
    input.fastTrackThresholdCents ?? DEFAULT_FAST_TRACK_THRESHOLD_CENTS;

  const promptInputBase: Omit<TriagePromptInput, 'clauses'> = {
    ...input,
    fastTrackThresholdCents,
  };

  const { middleware, getRetrievedClauses } = createPolicyWordingRagMiddleware(
    input.incidentNarrative,
    input.productType,
    promptInputBase,
  );

  const { object } = await generateObject({
    model: wrapLanguageModel({
      model: openai(TRIAGE_MODEL),
      middleware,
    }),
    schema: triageResultSchema,
    system: TRIAGE_SYSTEM_PROMPT,
    // The initial prompt is a placeholder; the middleware rewrites it with
    // the clause-enriched version before the model sees it.
    prompt: input.incidentNarrative,
    temperature: 0.1,
    maxRetries: 2,
  });

  // The model is asked not to exceed the coverage limit; enforce it anyway so a
  // bad generation can never book an over-limit payout.
  const recommendedPayoutCents = Math.min(
    object.recommendedPayoutCents,
    input.coverageAmountCents,
  );

  const retrievedClauses = getRetrievedClauses();

  return {
    ...object,
    recommendedPayoutCents,
    model: TRIAGE_MODEL,
    retrievedClauseIds: retrievedClauses.map((clause) => clause.clauseId),
  };
}
