import { Pinecone } from '@pinecone-database/pinecone';

/**
 * Pinecone holds the vector index of policy wording: every clause of every
 * product wording document, chunked and embedded. The triage agent searches it
 * so its decision can quote the clause it relied on.
 */
let pinecone: Pinecone | null = null;

export function getPinecone(): Pinecone {
  if (!pinecone) {
    pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  }
  return pinecone;
}

export function policyWordingIndex() {
  const indexName = process.env.PINECONE_INDEX || 'policy-wording';
  return getPinecone().index(indexName);
}

/**
 * Stable alias that queries always target. The alias is atomically repointed
 * to a new versioned namespace after a re-index completes, so queries never
 * hit a partially-written namespace (blue/green swap with no redeploy).
 *
 * Requires Pinecone API version 2026-07 or later (available on v9+ SDK).
 */
export const POLICY_WORDING_ALIAS =
  process.env.PINECONE_NAMESPACE_ALIAS || 'policy-wording-current';

/**
 * The versioned namespace that new wording is written into before the alias is
 * swapped. Falls back to the env var so operators can override it at deploy
 * time (e.g. "policy-wording-v2" during a planned re-index).
 *
 * After `indexPolicyWording` completes successfully the alias
 * `POLICY_WORDING_ALIAS` should be pointed at this value via
 * `upsertNamespaceAlias` so that reads automatically follow.
 */
export const POLICY_WORDING_NAMESPACE =
  process.env.PINECONE_NAMESPACE || 'policy-wording-v1';

/**
 * Atomically repoints the stable read alias to `targetNamespace`.
 * Call this after a successful re-index to make the new data live
 * without touching any query code.
 */
export async function swapPolicyWordingAlias(
  targetNamespace: string,
): Promise<void> {
  const indexName = process.env.PINECONE_INDEX || 'policy-wording';
  await getPinecone().index(indexName).upsertNamespaceAlias(POLICY_WORDING_ALIAS, {
    namespace: targetNamespace,
  });
}
