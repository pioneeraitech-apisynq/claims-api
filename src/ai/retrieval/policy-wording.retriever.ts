import { embedClauses, embedQuery } from './embeddings';
import {
  POLICY_WORDING_ALIAS,
  POLICY_WORDING_WRITE_NAMESPACE,
  policyWordingIndex,
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
    .namespace(POLICY_WORDING_ALIAS)
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
 * Writes into `POLICY_WORDING_WRITE_NAMESPACE` (defaults to the same value as
 * `POLICY_WORDING_ALIAS` when no shadow namespace is configured). After a
 * successful re-index run, call `flipPolicyWordingAlias` to atomically
 * repoint the alias to the newly written namespace.
 *
 * @returns The number of clauses successfully upserted.
 * @throws  If Pinecone reports any errors in the upsert response, so that
 *          partial failures are surfaced immediately rather than silently
 *          producing an under-populated index.
 */
export async function indexPolicyWording(
  productType: string,
  clauses: { clauseId: string; heading: string; text: string }[],
): Promise<number> {
  const vectors = await embedClauses(clauses.map((clause) => clause.text));

  const response = await policyWordingIndex()
    .namespace(POLICY_WORDING_WRITE_NAMESPACE)
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

  // The SDK returns an object that may carry an `errors` array when the
  // upsert is only partially applied (e.g. the batch was cut short).  Inspect
  // it explicitly so callers are never silently left with a partial index.
  const errors = (response as Record<string, unknown> | null)?.['errors'];
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(
      `Pinecone upsert for productType "${productType}" completed with errors: ` +
        JSON.stringify(errors),
    );
  }

  return clauses.length;
}
