import { Pinecone } from '@pinecone-database/pinecone';

/**
 * Pinecone holds the vector index of policy wording: every clause of every
 * product wording document, chunked and embedded. The triage agent searches it
 * so its decision can quote the clause it relied on.
 */
let pinecone: Pinecone | null = null;

export function getPinecone(): Pinecone {
  if (!pinecone) {
    // Explicitly target the 2026-07 stable API surface (SDK v9 default).
    // Passing apiVersion ensures we always reach the correct endpoint even if
    // a future SDK release moves the default forward.
    pinecone = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
      // @ts-ignore — `apiVersion` is a valid option on SDK v9; remove if the
      // type definition already exposes it in the version you install.
      apiVersion: '2026-07',
    });
  }
  return pinecone;
}

export function policyWordingIndex() {
  const indexName = process.env.PINECONE_INDEX || 'policy-wording';
  return getPinecone().index(indexName);
}

/**
 * Stable alias name for the policy-wording namespace.
 *
 * With API version 2026-07 Pinecone supports namespace aliases, which let you
 * atomically repoint this alias to a new underlying namespace (e.g.
 * `policy-wording-v2`) without any query downtime and without a redeploy.
 * To cut over, create the alias via the Pinecone control-plane API:
 *
 *   POST /indexes/{index}/namespaceAliases
 *   { "alias": "policy-wording", "namespace": "policy-wording-v2" }
 *
 * Both `searchPolicyWording` and `indexPolicyWording` resolve the namespace
 * through this constant so the alias is always the single source of truth.
 */
export const POLICY_WORDING_NAMESPACE =
  process.env.PINECONE_NAMESPACE || 'policy-wording';
