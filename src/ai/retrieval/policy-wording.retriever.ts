import {
  POLICY_WORDING_NAMESPACE,
  policyWordingDocumentIndex,
} from './pinecone.client';

/**
 * Retrieval-augmented search over policy wording.
 *
 * Uses the Pinecone Documents API against a schema-based index so that each
 * search is a hybrid BM25 + dense query (GA on API version 2026-07). This
 * matters for policy wording because exact matches on clause headings and legal
 * terminology carry real signal that pure cosine similarity cannot capture.
 *
 * The server generates all embeddings from the document `text` field, so no
 * client-side embedding step is needed at search time.
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
  const result = await policyWordingDocumentIndex()
    .namespace(POLICY_WORDING_NAMESPACE)
    .documents.search({
      inputs: { text: narrative },
      topK,
      filter: { productType: { $eq: productType } },
    });

  return (result.result?.hits || []).map((hit) => {
    const fields = (hit.fields || {}) as Record<string, unknown>;
    return {
      clauseId: hit._id,
      productType: String(fields.productType || productType),
      heading: String(fields.heading || ''),
      text: String(fields.text || ''),
      score: hit._score ?? 0,
    };
  });
}

/**
 * Index (or re-index) the clauses of a product wording document. Run when a
 * wording is published or amended.
 *
 * Documents are upserted via the Documents API; the server derives the dense
 * vector and BM25 index entries from the `text` field automatically.
 */
export async function indexPolicyWording(
  productType: string,
  clauses: { clauseId: string; heading: string; text: string }[],
): Promise<number> {
  await policyWordingDocumentIndex()
    .namespace(POLICY_WORDING_NAMESPACE)
    .documents.upsert(
      clauses.map((clause) => ({
        _id: clause.clauseId,
        text: clause.text,
        productType,
        heading: clause.heading,
      })),
    );

  return clauses.length;
}
