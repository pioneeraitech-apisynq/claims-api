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
 * Resolves the stable namespace alias for policy wording at runtime via the
 * Pinecone Namespace Aliases API (available on API 2026-07 / SDK v9+).
 *
 * Using an alias instead of a hardcoded namespace name means a new wording
 * version (e.g. policy-wording-v2) can be atomically swapped in by updating
 * the alias, with zero service redeploy and zero query downtime.
 *
 * The alias name itself is stable and controlled by PINECONE_NAMESPACE_ALIAS
 * (default: "policy-wording-current"). The underlying namespace it points to
 * (e.g. "policy-wording-v1", "policy-wording-v2") is managed out-of-band via
 * the Pinecone console or control-plane API.
 */
export async function policyWordingNamespace(): Promise<string> {
  const aliasName =
    process.env.PINECONE_NAMESPACE_ALIAS || 'policy-wording-current';
  const index = policyWordingIndex();
  const alias = await index.getNamespaceAlias(aliasName);
  return alias.namespace;
}
