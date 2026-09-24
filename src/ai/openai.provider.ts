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
 * ─── API Key governance (Findings 2 & 3) ────────────────────────────────────
 *
 * Finding 2 – Key expiration (high priority):
 *   OPENAI_API_KEY must be a project-scoped key with a configured expiration
 *   date. Administrators must enable "Maximum key lifetime" in the OpenAI
 *   Platform settings (platform.openai.com → Organisation → Settings → API
 *   keys) so that every newly created key is forced to expire within the
 *   approved window. A key without an expiration date must not be used in
 *   production. Rotate keys before expiry via the deployment pipeline and
 *   update the secret in your secrets manager (e.g. AWS Secrets Manager /
 *   Vault) automatically.
 *
 * Finding 3 – Workload identity federation (medium priority):
 *   For workloads that can obtain an OIDC/SPIFFE identity token from the
 *   runtime platform (e.g. AWS EKS IRSA, GCP Workload Identity, or an
 *   internal IdP), OpenAI workload identity federation lets the service
 *   exchange that short-lived token for a short-lived OpenAI access token with
 *   no long-lived key stored anywhere. See:
 *   https://platform.openai.com/docs/guides/workload-identity-federation
 *   When WIF is available, set OPENAI_API_KEY to the exchanged access token
 *   obtained at pod/container start-up and refresh it before expiry. Until WIF
 *   is adopted, mitigate risk by (a) enforcing key expiration (Finding 2),
 *   (b) scoping the key to the minimum required project permissions, and
 *   (c) storing it exclusively in the approved secrets manager — never in
 *   source control or unencrypted config files.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

if (!process.env.OPENAI_API_KEY) {
  throw new Error(
    '[openai.provider] OPENAI_API_KEY is not set. ' +
      'Provide a project-scoped key with an expiration date configured in ' +
      'the OpenAI Platform settings, or an access token obtained via ' +
      'workload identity federation.',
  );
}

export const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
});

/** Model used by the claim triage agent. */
export const TRIAGE_MODEL = 'gpt-4o-mini';

/** Model used to embed claim narratives and policy wording clauses. */
export const EMBEDDING_MODEL = 'text-embedding-3-small';
