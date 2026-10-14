import { embedClauses, embedQuery } from './embeddings';
import {
  POLICY_WORDING_ALIAS,
  POLICY_WORDING_NAMESPACE,
  policyWordingIndex,
  swapPolicyWordingAlias,
} from './pinecone.client';

/**
 * Retrieval-augmented search over policy wording.
 *
 * The claim narrative is embedded and matched against the clause index in
 * Pinecone. The top clauses are handed to the triage agent so its decision
 * cites the wording it relied on rather than inventing one.
 */

export interface PolicyClause {
  clauseId: string;
  productType: string;
  heading: string;
  text: string;
  score: number;
}

export class PineconeRetrievalError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PineconeRetrievalError';
  }
}

export async function searchPolicyWording(
  narrative: string,
  productType: string,
  topK = 4,
): Promise<PolicyClause[]> {
  const vector = await embedQuery(narrative);

  let result: Awaited<
    ReturnType<ReturnType<ReturnType<typeof policyWordingIndex>['namespace']>['query']>
  >;

  try {
    // Queries always target the stable alias so they automatically follow
    // any alias swap done by indexPolicyWording.
    result = await policyWordingIndex()
      .namespace(POLICY_WORDING_ALIAS)
      .query({
        vector,
        topK,
        includeMetadata: true,
        filter: { productType: { $eq: productType } },
      });
  } catch (err) {
    // Surface a structured error rather than crashing the triage agent with an
    // unhandled rejection (e.g. egress quota exhausted, network error).
    throw new PineconeRetrievalError(
      `Pinecone query failed — policy wording unavailable (namespace alias: ${POLICY_WORDING_ALIAS}). ` +
        'Check egress quota and Pinecone service status before retrying.',
      err,
    );
  }

  return (result.matches || []).map((match) => {
    const metadata = (match.metadata || {}) as Record<string, unknown>;
    return {
      clauseId: match.id,
      productType: String(metadata.productType || productType),
      heading: String(metadata.heading || ''),
      text: String(metadata.text || ''),
      score: match.score ?? 0,
    };
  });
}

/**
 * Index (or re-index) the clauses of a product wording document. Run when a
 * wording is published or amended.
 *
 * Writes into the versioned namespace (`POLICY_WORDING_NAMESPACE`) first, then
 * atomically swaps the stable alias to point at it. Queries continue to hit
 * the previous namespace until the swap completes, so there is no window of
 * partial data.
 */
export async function indexPolicyWording(
  productType: string,
  clauses: { clauseId: string; heading: string; text: string }[],
): Promise<number> {
  const vectors = await embedClauses(clauses.map((clause) => clause.text));

  try {
    await policyWordingIndex()
      .namespace(POLICY_WORDING_NAMESPACE)
      .upsert(
        clauses.map((clause, index) => ({
          id: clause.clauseId,
          values: vectors[index],
          metadata: {
            productType,
            heading: clause.heading,
            text: clause.text,
          },
        })),
      );
  } catch (err) {
    throw new PineconeRetrievalError(
      `Pinecone upsert failed — wording index not updated (namespace: ${POLICY_WORDING_NAMESPACE}). ` +
        'Check egress/ingest quota and Pinecone service status before retrying.',
      err,
    );
  }

  // Atomically repoint the stable alias so queries immediately see the newly
  // written namespace without any query-side code change or redeploy.
  await swapPolicyWordingAlias(POLICY_WORDING_NAMESPACE);

  return clauses.length;
}
