import { Pinecone } from '@pinecone-database/pinecone';

/**
 * Pinecone holds the vector index of policy wording: every clause of every
 * product wording document, chunked and embedded. The triage agent searches it
 * so its decision can quote the clause it relied on.
 *
 * SDK v9 targets Pinecone API version 2026-07 (the current stable release),
 * which gives us schema-based index creation, the Documents API, and full-text
 * search GA — no additional version configuration is required.
 */
let pinecone: Pinecone | null = null;

export function getPinecone(): Pinecone {
  if (!pinecone) {
    if (!process.env.PINECONE_API_KEY) {
      throw new Error(
        'PINECONE_API_KEY is not set — cannot construct the Pinecone client',
      );
    }
    pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  }
  return pinecone;
}

export function policyWordingIndex() {
  const indexName = process.env.PINECONE_INDEX || 'policy-wording';
  return getPinecone().index(indexName);
}

export const POLICY_WORDING_NAMESPACE =
  process.env.PINECONE_NAMESPACE || 'policy-wording-v1';
