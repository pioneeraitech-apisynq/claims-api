import { Pinecone } from '@pinecone-database/pinecone';

/**
 * Pinecone holds the vector index of policy wording: every clause of every
 * product wording document, chunked and embedded. The triage agent searches it
 * so its decision can quote the clause it relied on.
 */
let pinecone: Pinecone | null = null;

export function getPinecone(): Pinecone {
  if (!pinecone) {
    if (!process.env.PINECONE_API_KEY) {
      throw new Error('PINECONE_API_KEY is required but was not set');
    }
    pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  }
  return pinecone;
}

export function policyWordingIndex() {
  const indexName = process.env.PINECONE_INDEX || 'policy-wording';
  return getPinecone().index(indexName);
}

/**
 * Returns a namespace handle bound to the policy-wording alias.
 *
 * Using a namespace alias (rather than a hard-coded namespace string) lets ops
 * atomically repoint the alias to a freshly indexed namespace (e.g.
 * `policy-wording-v2`) with zero downtime and no redeployment required.
 */
export function policyWordingNamespace() {
  const aliasName =
    process.env.PINECONE_NAMESPACE_ALIAS || 'policy-wording-alias';
  return policyWordingIndex().namespaceAlias(aliasName);
}
