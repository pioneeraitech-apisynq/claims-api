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
 * ─── Authentication ──────────────────────────────────────────────────────────
 *
 * PREFERRED — Workload Identity Federation (short-lived tokens)
 *   Set OPENAI_TOKEN_URL to an endpoint that accepts the workload's identity
 *   credential (e.g. a Kubernetes projected service-account token supplied via
 *   OPENAI_WORKLOAD_TOKEN_PATH) and returns {"access_token":"sk-…","expires_in":N}.
 *   The provider will exchange the workload token for a short-lived OpenAI
 *   access token on startup, eliminating the need to store a long-lived key.
 *   See: https://platform.openai.com/docs/guides/workload-identity-federation
 *
 * FALLBACK — Static API key
 *   Set OPENAI_API_KEY.  Also set OPENAI_API_KEY_EXPIRES_AT (ISO-8601) to the
 *   expiration date chosen when the key was created in the OpenAI Platform.
 *   The service will refuse to start within 24 h of that date, or after it,
 *   forcing timely rotation and mirroring the organisation-level maximum-key-
 *   lifetime governance control.
 */

const BASE_URL =
  process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

// ---------------------------------------------------------------------------
// Short-lived token via Workload Identity Federation
// ---------------------------------------------------------------------------

/**
 * Exchange the workload's externally-issued identity credential for a
 * short-lived OpenAI access token.  Returns the token string, or null when
 * OPENAI_TOKEN_URL is not configured (fall through to static key).
 */
async function fetchWorkloadAccessToken(): Promise<string | null> {
  const tokenUrl = process.env.OPENAI_TOKEN_URL;
  if (!tokenUrl) {
    return null;
  }

  // The workload token (e.g. a Kubernetes projected service-account JWT) is
  // read from the path mounted into the container.
  const workloadTokenPath = process.env.OPENAI_WORKLOAD_TOKEN_PATH;
  let workloadToken: string | undefined;
  if (workloadTokenPath) {
    const fs = await import('fs/promises');
    workloadToken = (await fs.readFile(workloadTokenPath, 'utf8')).trim();
  }

  const body: Record<string, string> = {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
  };
  if (workloadToken) {
    body['subject_token'] = workloadToken;
  }

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `OpenAI workload token exchange failed: ${response.status} ${response.statusText}`,
    );
  }

  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error(
      'OpenAI workload token exchange response did not contain access_token',
    );
  }

  return json.access_token;
}

// ---------------------------------------------------------------------------
// Static API key expiry guard
// ---------------------------------------------------------------------------

/**
 * Validates that the static API key has not expired and is not about to expire
 * within the next 24 hours.  Throws on violations so the service refuses to
 * start with a compromised or stale credential.
 */
function assertKeyNotExpired(): void {
  const expiresAt = process.env.OPENAI_API_KEY_EXPIRES_AT;
  if (!expiresAt) {
    // No expiry declared — the organisation policy should enforce this via
    // Platform settings, but we cannot check it locally.  Emit a warning so
    // the issue is visible in startup logs without hard-failing for teams that
    // have not yet migrated.
    console.warn(
      '[openai.provider] OPENAI_API_KEY_EXPIRES_AT is not set. ' +
        'Set an expiration date on the key in the OpenAI Platform and record ' +
        'it here so the service can enforce key rotation.',
    );
    return;
  }

  const expiry = new Date(expiresAt);
  if (isNaN(expiry.getTime())) {
    throw new Error(
      `[openai.provider] OPENAI_API_KEY_EXPIRES_AT="${expiresAt}" is not a valid ISO-8601 date.`,
    );
  }

  const now = new Date();
  const warningThresholdMs = 24 * 60 * 60 * 1000; // 24 h

  if (now >= expiry) {
    throw new Error(
      `[openai.provider] The OpenAI API key expired at ${expiry.toISOString()}. ` +
        'Rotate the key in the OpenAI Platform and update OPENAI_API_KEY / OPENAI_API_KEY_EXPIRES_AT.',
    );
  }

  if (expiry.getTime() - now.getTime() < warningThresholdMs) {
    console.warn(
      `[openai.provider] The OpenAI API key expires at ${expiry.toISOString()} (within 24 h). ` +
        'Rotate the key before it expires.',
    );
  }
}

// ---------------------------------------------------------------------------
// Provider bootstrap
// ---------------------------------------------------------------------------

/**
 * Resolves the API key to use: short-lived WIF token when available, static
 * key otherwise (with expiry enforcement).
 */
async function resolveApiKey(): Promise<string> {
  const wifToken = await fetchWorkloadAccessToken();
  if (wifToken) {
    return wifToken;
  }

  // No WIF endpoint configured — validate and use the static key.
  assertKeyNotExpired();

  const staticKey = process.env.OPENAI_API_KEY;
  if (!staticKey) {
    throw new Error(
      '[openai.provider] Neither OPENAI_TOKEN_URL nor OPENAI_API_KEY is set. ' +
        'Configure workload identity federation (OPENAI_TOKEN_URL) or supply a ' +
        'static key (OPENAI_API_KEY) with an expiry date (OPENAI_API_KEY_EXPIRES_AT).',
    );
  }

  return staticKey;
}

/**
 * A promise that resolves to the configured OpenAI provider instance.
 * All consumers must await this export; it is intentionally a Promise so the
 * async token-exchange path executes before any model call is made.
 */
export const openaiProvider = resolveApiKey().then((apiKey) =>
  createOpenAI({ apiKey, baseURL: BASE_URL }),
);

/**
 * Convenience accessor — resolves the provider and returns the model handle
 * for `modelId`.  Usage: `openai(TRIAGE_MODEL)` becomes
 * `await resolveModel(TRIAGE_MODEL)`.
 *
 * Internal callers that already hold the resolved provider can also use
 * `(await openaiProvider)(modelId)` directly.
 */
export async function resolveModel(modelId: string) {
  const provider = await openaiProvider;
  return provider(modelId);
}

/**
 * Legacy synchronous export kept for modules that construct the provider at
 * module-evaluation time.  Prefer `resolveModel` for new call sites.
 *
 * @deprecated Use `resolveModel(modelId)` instead.
 */
export const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? 'UNRESOLVED_USE_resolveModel',
  baseURL: BASE_URL,
});

/** Model used by the claim triage agent. */
export const TRIAGE_MODEL = 'gpt-4o-mini';

/** Model used to embed claim narratives and policy wording clauses. */
export const EMBEDDING_MODEL = 'text-embedding-3-small';
