import { createGateway } from '@ai-sdk/gateway';

/**
 * Vercel AI Gateway provider.
 *
 * All model traffic — OpenAI chat completions, OpenAI embeddings, and Anthropic
 * completions — is routed through a single Vercel AI Gateway integration point.
 * Set AI_GATEWAY_URL to your APISynQ gateway base URL
 * (e.g. https://governance-api.apisynq.com/v1/ai-gw) and AI_GATEWAY_API_KEY to
 * the corresponding key; the defaults fall back to the public Vercel AI Gateway.
 */
const gateway = createGateway({
  apiKey: process.env.AI_GATEWAY_API_KEY,
  baseURL: process.env.AI_GATEWAY_URL,
});

/** Gateway-scoped OpenAI provider (chat completions + embeddings). */
export const openai = gateway.openai;

/** Gateway-scoped Anthropic provider (document extraction). */
export const anthropic = gateway.anthropic;

/** Model used by the claim triage agent. */
export const TRIAGE_MODEL = 'gpt-4o-mini';

/** Model used to embed claim narratives and policy wording clauses. */
export const EMBEDDING_MODEL = 'text-embedding-3-small';
