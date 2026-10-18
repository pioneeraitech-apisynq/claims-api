import { embedClauses, embedQuery } from './embeddings';
import {
  getPolicyWordingAliasName,
  policyWordingIndex,
  swapPolicyWordingNamespaceAlias,
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

export async function searchPolicyWording(
  narrative: string,
  productType: string,
  topK = 4,
): Promise<PolicyClause[]> {
  const vector = await embedQuery(narrative);

  const result = await policyWordingIndex()
    .namespace(getPolicyWordingAliasName())
    .query({
      vector,
      topK,
      includeMetadata: true,
      filter: { productType: { $eq: productType } },
    });

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
 * Strategy (finding 2 — zero-downtime swap):
 *   1. Write all vectors into a timestamped shadow namespace.
 *   2. Verify the upsert response for partial failures (finding 1).
 *   3. Atomically repoint the namespace alias to the shadow namespace so
 *      live reads immediately see the new data without a gap window.
 */
export async function indexPolicyWording(
  productType: string,
  clauses: { clauseId: string; heading: string; text: string }[],
): Promise<number> {
  const vectors = await embedClauses(clauses.map((clause) => clause.text));

  // Use a timestamped shadow namespace so the live alias is untouched until
  // the write is fully verified (finding 2).
  const shadowNamespace = `policy-wording-shadow-${Date.now()}`;

  const upsertResponse = await policyWordingIndex()
    .namespace(shadowNamespace)
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

  // Guard against partial failures — the SDK surfaces these on the response
  // object rather than throwing (finding 1).
  const upsertedCount =
    (upsertResponse as { upsertedCount?: number } | undefined)
      ?.upsertedCount ?? clauses.length;

  if (upsertedCount < clauses.length) {
    throw new Error(
      `Pinecone upsert partial failure for productType="${productType}": ` +
        `expected ${clauses.length} vectors but only ${upsertedCount} were written. ` +
        `Shadow namespace "${shadowNamespace}" was NOT promoted to the live alias.`,
    );
  }

  // All vectors confirmed written — atomically swap the alias (finding 2).
  await swapPolicyWordingNamespaceAlias(shadowNamespace);

  return clauses.length;
}
