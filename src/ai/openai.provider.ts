import { createGateway } from '@ai-sdk/gateway';

/**
 * AI SDK Gateway provider.
 *
 * All model calls — chat completions for triage and embeddings for policy
 * wording retrieval — are addressed via the unified Gateway string format
 * (e.g. `'openai/gpt-4o-mini'`).  Routing traffic through the APISynQ AI
 * gateway requires no code change: set GATEWAY_BASE_URL to
 * https://governance-api.apisynq.com/v1/ai-gw and the gateway provider
 * handles the rest.
 */
export const gateway = createGateway({
  apiKey: process.env.GATEWAY_API_KEY,
  baseURL: process.env.GATEWAY_BASE_URL,
});

/** Model used by the claim triage agent. */
export const TRIAGE_MODEL = 'openai/gpt-4o-mini';

/** Model used to embed claim narratives and policy wording clauses. */
export const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
