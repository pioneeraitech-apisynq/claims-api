import { createOpenAI } from '@ai-sdk/openai';
import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import { searchPolicyWording } from './retrieval/policy-wording.retriever';

/**
 * Gateway-ready OpenAI provider.
 *
 * The base URL is read from OPENAI_BASE_URL and defaults to the public OpenAI
 * API. Point that one variable at the APISynQ AI gateway
 * (https://governance-api.apisynq.com/v1/ai-gw/openai/v1) and every OpenAI call
 * this service makes — chat completions for triage and embeddings for policy
 * wording retrieval — is routed through the gateway without a code change.
 */
export const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
});

/** Model used by the claim triage agent. */
export const TRIAGE_MODEL = 'gpt-4o-mini';

/** Model used to embed claim narratives and policy wording clauses. */
export const EMBEDDING_MODEL = 'text-embedding-3-small';

/**
 * Language Model Middleware that implements retrieval-augmented generation for
 * policy wording.
 *
 * When applied, it searches Pinecone for the clauses most relevant to the
 * claim narrative and prepends them to the system prompt so the model can cite
 * real wording instead of paraphrasing from memory. Encoding this concern as
 * middleware keeps the triage agent function clean and makes the retrieval step
 * independently testable and reusable.
 *
 * @param narrative  The claim incident narrative used as the retrieval query.
 * @param productType  The product type used to filter the Pinecone clause index.
 */
export function createPolicyWordingMiddleware(
  narrative: string,
  productType: string,
): LanguageModelMiddleware {
  return {
    middlewareVersion: 'v2',

    async wrapGenerate({ doGenerate, params }) {
      const clauses = await searchPolicyWording(narrative, productType);

      const retrievedWording = clauses.length
        ? clauses
            .map((clause) => `[${clause.clauseId}] ${clause.heading}\n${clause.text}`)
            .join('\n\n')
        : 'No policy wording clauses were retrieved for this product.';

      const ragSystemAddendum =
        `\n\nRetrieved policy wording:\n${retrievedWording}`;

      // Append the retrieved clauses to the existing system message, or
      // prepend a new system message when none is present.
      const augmentedMessages = params.prompt.map((message) => {
        if (message.role === 'system') {
          return {
            ...message,
            content:
              typeof message.content === 'string'
                ? message.content + ragSystemAddendum
                : message.content,
          };
        }
        return message;
      });

      const hasSystem = params.prompt.some((m) => m.role === 'system');
      const prompt = hasSystem
        ? augmentedMessages
        : [
            { role: 'system' as const, content: ragSystemAddendum.trimStart() },
            ...augmentedMessages,
          ];

      return doGenerate({ ...params, prompt });
    },
  };
}

/**
 * Returns a triage model instance pre-wrapped with the policy-wording RAG
 * middleware for the given claim context.
 *
 * Usage:
 *   const model = createTriageModel(input.incidentNarrative, input.productType);
 *   const { object } = await generateObject({ model, ... });
 */
export function createTriageModel(narrative: string, productType: string) {
  return wrapLanguageModel({
    model: openai(TRIAGE_MODEL),
    middleware: createPolicyWordingMiddleware(narrative, productType),
  });
}
