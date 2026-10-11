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
      throw new Error('PINECONE_API_KEY is not set');
    }
    pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  }
  return pinecone;
}

/**
 * Returns a namespace-scoped index handle for the policy-wording index.
 *
 * The namespace is resolved via a Pinecone namespace alias
 * (`PINECONE_NAMESPACE_ALIAS`, default: `"policy-wording-current"`).
 * Pointing the alias at a new namespace (e.g. `policy-wording-v2`) in the
 * Pinecone console or via the API atomically re-routes reads and writes
 * without any code change or redeployment.
 */
export async function policyWordingIndex() {
  const pc = getPinecone();
  const indexName = process.env.PINECONE_INDEX || 'policy-wording';
  const aliasName =
    process.env.PINECONE_NAMESPACE_ALIAS || 'policy-wording-current';

  // Resolve the alias to the concrete namespace it currently points at.
  // SDK v9 exposes describeNamespace on the Index object.
  const idx = pc.index(indexName);
  const aliasDescription = await idx.describeNamespace(aliasName);
  const resolvedNamespace = aliasDescription.name ?? aliasName;

  return idx.namespace(resolvedNamespace);
}
