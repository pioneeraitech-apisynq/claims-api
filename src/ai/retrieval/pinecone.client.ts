import { Pinecone } from '@pinecone-database/pinecone';

/**
 * Pinecone holds the vector index of policy wording: every clause of every
 * product wording document, chunked and embedded. The triage agent searches it
 * so its decision can quote the clause it relied on.
 */
let pinecone: Pinecone | null = null;

export function getPinecone(): Pinecone {
  if (!pinecone) {
    const apiKey = process.env.PINECONE_API_KEY;
    if (!apiKey) {
      throw new Error(
        'PINECONE_API_KEY is not set — add it to your environment before starting the service.',
      );
    }
    pinecone = new Pinecone({ apiKey });
  }
  return pinecone;
}

export function policyWordingIndex() {
  const indexName = process.env.PINECONE_INDEX || 'policy-wording';
  return getPinecone().index(indexName);
}

/**
 * The namespace used for policy-wording vectors.
 *
 * With SDK v9 (API 2026-07) you can configure a namespace alias in the
 * Pinecone console and point PINECONE_NAMESPACE at it.  Swapping the alias
 * to a freshly re-indexed namespace (e.g. policy-wording-v2) then requires
 * no code change or redeployment — just update the alias target.
 */
export const POLICY_WORDING_NAMESPACE =
  process.env.PINECONE_NAMESPACE || 'policy-wording-v1';
