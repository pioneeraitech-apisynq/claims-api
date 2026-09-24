import { generateObject, wrapLanguageModel } from 'ai';
import type { LanguageModelV1Middleware } from 'ai';
import { z } from 'zod';
import { TRIAGE_MODEL, gateway } from '../../openai.provider';
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
 * result. Relevant policy wording clauses are injected via Language Model
 * Middleware so the agent quotes real wording instead of paraphrasing from
 * memory — and the generateObject call stays clean and provider-agnostic.
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
 * Language Model Middleware that performs RAG retrieval and injects the
 * retrieved policy wording clauses into the prompt before the model is called.
 * Centralising retrieval here keeps generateObject clean and makes the logic
 * reusable across any model wrapped with this middleware.
 */
function buildPolicyRagMiddleware(
  input: TriageAgentInput,
  onClauses: (ids: string[]) => void,
): LanguageModelV1Middleware {
  return {
    wrapGenerate: async ({ doGenerate, params }) => {
      const clauses = await searchPolicyWording(
        input.incidentNarrative,
        input.productType,
      );
      onClauses(clauses.map((c) => c.clauseId));

      const promptInput: TriagePromptInput = {
        ...input,
        fastTrackThresholdCents:
          input.fastTrackThresholdCents ?? DEFAULT_FAST_TRACK_THRESHOLD_CENTS,
        clauses,
      };

      // Replace the prompt with the RAG-enriched version.
      const enrichedParams = {
        ...params,
        prompt: [
          {
            role: 'user' as const,
            content: [
              {
                type: 'text' as const,
                text: buildTriagePrompt(promptInput),
              },
            ],
          },
        ],
      };

      return doGenerate(enrichedParams);
    },
  };
}

export async function runTriageAgent(
  input: TriageAgentInput,
): Promise<TriageAgentOutput> {
  let retrievedClauseIds: string[] = [];

  const modelWithRag = wrapLanguageModel({
    model: gateway(TRIAGE_MODEL),
    middleware: buildPolicyRagMiddleware(input, (ids) => {
      retrievedClauseIds = ids;
    }),
  });

  const { object } = await generateObject({
    model: modelWithRag,
    schema: triageResultSchema,
    system: TRIAGE_SYSTEM_PROMPT,
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

  return {
    ...object,
    recommendedPayoutCents,
    model: TRIAGE_MODEL,
    retrievedClauseIds,
  };
}
