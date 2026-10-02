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
 * Stable namespace alias name used for every query and upsert.
 *
 * With Pinecone API 2026-07 (SDK v9), this value is treated as a namespace
 * alias rather than a literal namespace. The alias can be atomically repointed
 * to a freshly populated underlying namespace after a wording amendment
 * (e.g. via the Pinecone console or control-plane API), achieving a
 * zero-downtime data swap without redeployment or dual writes.
 *
 * To perform a re-index:
 *   1. Upsert all clauses into a new concrete namespace (e.g. policy-wording-v2).
 *   2. Verify upsertedCount matches the expected clause count (see indexPolicyWording).
 *   3. Repoint the alias `policy-wording-current` → `policy-wording-v2`
 *      via the Pinecone API (PUT /namespaces/{alias}).
 *   4. Delete the old concrete namespace when traffic confirms the switch.
 */
export const POLICY_WORDING_NAMESPACE =
  process.env.PINECONE_NAMESPACE || 'policy-wording-current';
