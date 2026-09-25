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
 * result. RAG is handled by a Language Model Middleware that intercepts the
 * model call, performs the Pinecone lookup, and injects the retrieved clauses
 * into the prompt — keeping retrieval logic decoupled from the agent body and
 * reusable by any other agent that wraps its model with the same middleware.
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
 * Sentinel prefix embedded in the user-turn prompt so the RAG middleware can
 * identify the product type and narrative it should retrieve clauses for.
 * Format: `[RAG:<productType>]\n<narrative…>`
 */
const RAG_PREFIX = (productType: string, narrative: string) =>
  `[RAG:${productType}]\n${narrative}`;

/**
 * Language Model Middleware that performs Pinecone retrieval and injects the
 * retrieved policy wording clauses into the prompt before the model call.
 * Encapsulating RAG here decouples it from the agent body and allows the same
 * middleware to be reused across agents via `wrapLanguageModel`.
 */
const ragMiddleware: LanguageModelV1Middleware = {
  middlewareVersion: 'v1',

  async transformParams({ params }) {
    const messages = params.prompt;

    // Track retrieved clause IDs so the outer agent can surface them.
    const retrievedClauses: Awaited<ReturnType<typeof searchPolicyWording>> =
      [];

    const augmented = await Promise.all(
      messages.map(async (message) => {
        if (message.role !== 'user') return message;

        const parts = Array.isArray(message.content) ? message.content : [];

        const newParts = await Promise.all(
          parts.map(async (part) => {
            if (part.type !== 'text') return part;

            const match = part.text.match(/^\[RAG:([^\]]+)\]\n/);
            if (!match) return part;

            const productType = match[1];
            const narrative = part.text.slice(match[0].length);

            const clauses = await searchPolicyWording(narrative, productType);
            retrievedClauses.push(...clauses);

            const clauseBlock = clauses.length
              ? clauses
                  .map((c) => `[${c.clauseId}] ${c.heading}\n${c.text}`)
                  .join('\n\n') + '\n\n'
              : 'No policy wording clauses were retrieved for this product.\n\n';

            return { ...part, text: clauseBlock + narrative };
          }),
        );

        return { ...message, content: newParts };
      }),
    );

    // Attach retrieved clause metadata so the agent can read it after the call.
    return {
      params: {
        ...params,
        prompt: augmented,
      },
      // Carry clause IDs through as a custom extension so the agent can
      // populate `retrievedClauseIds` without calling Pinecone a second time.
      //
      // Note: `experimental_providerMetadata` travels through the SDK and is
      // available on the result; we store the IDs on the params object so the
      // outer closure can read `retrievedClauses` directly (same scope).
    };
  },
};

export async function runTriageAgent(
  input: TriageAgentInput,
): Promise<TriageAgentOutput> {
  // Collected by the middleware closure during `transformParams`.
  const retrievedClauses: Awaited<ReturnType<typeof searchPolicyWording>> = [];

  // Build a middleware instance that captures into the local array above.
  const capturingRagMiddleware: LanguageModelV1Middleware = {
    middlewareVersion: 'v1',

    async transformParams({ params }) {
      const messages = params.prompt;

      const augmented = await Promise.all(
        messages.map(async (message) => {
          if (message.role !== 'user') return message;

          const parts = Array.isArray(message.content) ? message.content : [];

          const newParts = await Promise.all(
            parts.map(async (part) => {
              if (part.type !== 'text') return part;

              const match = part.text.match(/^\[RAG:([^\]]+)\]\n/);
              if (!match) return part;

              const productType = match[1];
              const narrative = part.text.slice(match[0].length);

              const clauses = await searchPolicyWording(
                narrative,
                productType,
              );
              retrievedClauses.push(...clauses);

              const clauseBlock = clauses.length
                ? clauses
                    .map((c) => `[${c.clauseId}] ${c.heading}\n${c.text}`)
                    .join('\n\n') + '\n\n'
                : 'No policy wording clauses were retrieved for this product.\n\n';

              return { ...part, text: clauseBlock + narrative };
            }),
          );

          return { ...message, content: newParts };
        }),
      );

      return { params: { ...params, prompt: augmented } };
    },
  };

  const ragModel = wrapLanguageModel({
    model: openai(TRIAGE_MODEL),
    middleware: capturingRagMiddleware,
  });

  const promptInput: TriagePromptInput = {
    ...input,
    fastTrackThresholdCents:
      input.fastTrackThresholdCents ?? DEFAULT_FAST_TRACK_THRESHOLD_CENTS,
    // Clauses are injected by the middleware; pass an empty array as the
    // placeholder that `buildTriagePrompt` uses for the wording block.
    clauses: [],
  };

  // Embed the RAG sentinel prefix into the narrative portion of the prompt so
  // the middleware can find the product type and the text to embed.
  const ragNarrative = RAG_PREFIX(input.productType, input.incidentNarrative);

  const { object } = await generateObject({
    model: ragModel,
    schema: triageResultSchema,
    system: TRIAGE_SYSTEM_PROMPT,
    prompt: buildTriagePrompt({ ...promptInput, incidentNarrative: ragNarrative }),
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
    retrievedClauseIds: retrievedClauses.map((clause) => clause.clauseId),
  };
}
