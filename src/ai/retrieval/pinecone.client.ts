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
        'PINECONE_API_KEY environment variable is not set. ' +
          'Provide a valid API key before starting the service.',
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
 * Resolves the active namespace for policy wording queries.
 *
 * Prefer PINECONE_NAMESPACE_ALIAS (a stable alias managed via the Pinecone
 * REST API, e.g. "policy-wording-current") so a new namespace can be atomically
 * cut over without redeployment.  PINECONE_NAMESPACE is kept as a direct
 * override for local development or one-off testing.  The hard-coded fallback
 * is intentionally generic; real environments should always set one of the two
 * variables and point a namespace alias at the live versioned namespace.
 */
export function getPolicyWordingNamespace(): string {
  return (
    process.env.PINECONE_NAMESPACE_ALIAS ||
    process.env.PINECONE_NAMESPACE ||
    'policy-wording-current'
  );
}

/** @deprecated Use getPolicyWordingNamespace() so the alias path is exercised. */
export const POLICY_WORDING_NAMESPACE = getPolicyWordingNamespace();
