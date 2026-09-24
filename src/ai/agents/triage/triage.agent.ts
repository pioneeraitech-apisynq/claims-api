import { generateObject, wrapLanguageModel, type LanguageModelV2Middleware } from 'ai';
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
 * Runs OpenAI gpt-4o-mini through the Vercel AI SDK with a zod-constrained
 * result. A Language Model Middleware intercepts the call to retrieve the
 * relevant policy wording clauses from Pinecone and inject them into the
 * prompt, so the agent quotes real wording instead of paraphrasing from
 * memory. The retrieval logic is fully decoupled from the agent's call-site.
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
 * Language Model Middleware that performs RAG for the triage agent.
 *
 * The middleware extracts the narrative and productType that were embedded in
 * the prompt by `buildTriagePrompt`, searches Pinecone for matching policy
 * wording clauses, then rewrites the last user message so the model receives
 * the retrieved wording — all without touching the agent's call-site.
 *
 * The retrieved clause ids are stored on a per-call context object so
 * `runTriageAgent` can surface them in its return value.
 */
function createRagMiddleware(
  onClauses: (clauseIds: string[]) => void,
  input: TriageAgentInput,
  fastTrackThresholdCents: number,
): LanguageModelV2Middleware {
  return {
    middlewareVersion: 'v2',
    async transformParams({ params }) {
      const clauses = await searchPolicyWording(
        input.incidentNarrative,
        input.productType,
      );

      onClauses(clauses.map((c) => c.clauseId));

      const promptInput: TriagePromptInput = {
        ...input,
        fastTrackThresholdCents,
        clauses,
      };

      const enrichedPrompt = buildTriagePrompt(promptInput);

      // Replace the last user message (the raw prompt) with the clause-enriched
      // version. All other params (system, temperature, schema, …) are passed
      // through unchanged.
      const messages = params.prompt.map((message, index) => {
        if (
          index === params.prompt.length - 1 &&
          message.role === 'user'
        ) {
          return {
            ...message,
            content: [{ type: 'text' as const, text: enrichedPrompt }],
          };
        }
        return message;
      });

      return { ...params, prompt: messages };
    },
  };
}

export async function runTriageAgent(
  input: TriageAgentInput,
): Promise<TriageAgentOutput> {
  const fastTrackThresholdCents =
    input.fastTrackThresholdCents ?? DEFAULT_FAST_TRACK_THRESHOLD_CENTS;

  let retrievedClauseIds: string[] = [];

  const ragModel = wrapLanguageModel({
    model: openai(TRIAGE_MODEL),
    middleware: createRagMiddleware(
      (ids) => { retrievedClauseIds = ids; },
      input,
      fastTrackThresholdCents,
    ),
  });

  const { object } = await generateObject({
    model: ragModel,
    schema: triageResultSchema,
    system: TRIAGE_SYSTEM_PROMPT,
    // The raw narrative is passed as the initial prompt; the middleware replaces
    // it with the fully rendered, clause-enriched prompt before the provider
    // call is made.
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
