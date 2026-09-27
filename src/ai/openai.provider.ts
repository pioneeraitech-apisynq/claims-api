import { createOpenAI } from '@ai-sdk/openai';

/**
 * Gateway-ready OpenAI provider.
 *
 * The base URL is read from OPENAI_BASE_URL and defaults to the public OpenAI
 * API. Point that one variable at the APISynQ AI gateway
 * (https://governance-api.apisynq.com/v1/ai-gw/openai/v1) and every OpenAI call
 * this service makes — chat completions for triage and embeddings for policy
 * wording retrieval — is routed through the gateway without a code change.
 *
 * ─── OPERATIONAL REQUIREMENTS (OpenAI key governance) ─────────────────────────
 *
 * 1. SERVICE-ACCOUNT KEY (finding: better-practice/medium)
 *    OPENAI_API_KEY MUST be a service-account key, not a user-owned project key.
 *    Steps:
 *      a. In the OpenAI Platform, navigate to
 *         Settings → Project → Service Accounts and create a dedicated service
 *         account for this workload (e.g. "claims-triage-prod").
 *      b. Generate an API key scoped to that service account.
 *      c. Store the key in your secrets manager and inject it as OPENAI_API_KEY.
 *      d. Revoke any user-owned key previously used for this workload.
 *      e. In Settings → Project → Governance, disable user-owned project key
 *         creation so the policy is enforced organisation-wide.
 *    Rationale: a user-owned key is tied to an individual account; if that user
 *    is removed the integration breaks and the key cannot be audited separately.
 *
 * 2. KEY EXPIRATION & ROTATION POLICY (finding: better-practice/high)
 *    Every OPENAI_API_KEY used by this service MUST have an expiration date and
 *    MUST be rotated before it expires.
 *    Steps:
 *      a. When creating or renewing the service-account key in the OpenAI
 *         Platform, set an expiration date no more than 90 days in the future.
 *      b. In Settings → Organisation → Governance, set "Maximum API key
 *         lifetime" to 90 days (or your organisation's policy maximum) so the
 *         platform enforces this limit for all keys.
 *      c. Add a calendar reminder or CI pipeline check that alerts at least
 *         14 days before the key's expiry so it can be rotated with zero
 *         downtime (generate the new key, update the secret, then revoke the
 *         old one).
 *    Rationale: a long-lived key that is never rotated significantly increases
 *    the blast radius of a credential leak.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 */
export const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
});

/** Model used by the claim triage agent. */
export const TRIAGE_MODEL = 'gpt-4o-mini';

/** Model used to embed claim narratives and policy wording clauses. */
export const EMBEDDING_MODEL = 'text-embedding-3-small';
