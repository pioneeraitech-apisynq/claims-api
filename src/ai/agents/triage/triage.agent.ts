import { generateObject, wrapLanguageModel } from 'ai';
import type { LanguageModelV1Middleware } from 'ai';
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
 * result. The policy-wording retrieval is encapsulated in a Language Model
 * Middleware layer so the RAG concern is transparent to this orchestration
 * code, reusable across agents, and independently testable/swappable.
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
 * Language Model Middleware that performs policy-wording RAG before the model
 * sees the prompt. The retrieved clauses are injected into the last user
 * message so the agent can quote the wording it relied on. This keeps
 * retrieval concerns out of the orchestration code and makes the step easy to
 * swap or test independently.
 */
function createPolicyWordingMiddleware(
  productType: string,
  onClauses: (clauseIds: string[]) => void,
): LanguageModelV1Middleware {
  return {
    middlewareVersion: 'v2',
    async transformParams({ params }) {
      const clauses = await searchPolicyWording(
        // Extract the narrative from the last user message for the vector query.
        (() => {
          const messages = params.prompt;
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.role === 'user') {
              const textPart = msg.content.find((p) => p.type === 'text');
              if (textPart && textPart.type === 'text') return textPart.text;
            }
          }
          return '';
        })(),
        productType,
      );

      onClauses(clauses.map((c) => c.clauseId));

      if (clauses.length === 0) {
        return params;
      }

      // Append retrieved wording as a system message so it is clearly
      // separated from the policyholder-supplied content.
      const wordingBlock = clauses
        .map((clause) => `[${clause.clauseId}] ${clause.heading}\n${clause.text}`)
        .join('\n\n');

      return {
        ...params,
        prompt: [
          ...params.prompt,
          {
            role: 'user' as const,
            content: [
              {
                type: 'text' as const,
                text: `Retrieved policy wording:\n${wordingBlock}`,
              },
            ],
          },
        ],
      };
    },
  };
}

export async function runTriageAgent(
  input: TriageAgentInput,
): Promise<TriageAgentOutput> {
  const retrievedClauseIds: string[] = [];

  const promptInput: TriagePromptInput = {
    ...input,
    fastTrackThresholdCents:
      input.fastTrackThresholdCents ?? DEFAULT_FAST_TRACK_THRESHOLD_CENTS,
    // Clauses are injected by the middleware; pass an empty array as the
    // placeholder so buildTriagePrompt omits the wording section from the
    // base prompt (the middleware appends it instead).
    clauses: [],
  };

  const modelWithRag = wrapLanguageModel({
    model: openai(TRIAGE_MODEL),
    middleware: createPolicyWordingMiddleware(
      input.productType,
      (ids) => retrievedClauseIds.push(...ids),
    ),
  });

  const { object } = await generateObject({
    model: modelWithRag,
    schema: triageResultSchema,
    system: TRIAGE_SYSTEM_PROMPT,
    prompt: buildTriagePrompt(promptInput),
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
