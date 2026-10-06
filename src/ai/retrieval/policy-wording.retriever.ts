import { embedClauses, embedQuery } from './embeddings';
import {
  ATLAS_VECTOR_INDEX,
  POLICY_WORDING_COLLECTION,
  getPolicyWordingCollection,
} from './pinecone.client';

/**
 * Retrieval-augmented search over policy wording — now backed by MongoDB Atlas
 * Vector Search instead of Pinecone.
 *
 * The claim narrative is embedded and matched against the clause index in the
 * `policy_wording_clauses` Atlas collection via the `$vectorSearch` aggregation
 * stage.  The top clauses are handed to the triage agent so its decision cites
 * the wording it relied on rather than inventing one.
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

  const collection = getPolicyWordingCollection();

  // $vectorSearch requires MongoDB 6.0.11+ / Atlas Search with a vector index.
  // The `filter` sub-document pushes the productType predicate into the ANN
  // search so only clauses for the relevant product are considered.
  const pipeline = [
    {
      $vectorSearch: {
        index: ATLAS_VECTOR_INDEX,
        path: 'embedding',
        queryVector: vector,
        numCandidates: topK * 10,
        limit: topK,
        filter: { productType: { $eq: productType } },
      },
    },
    {
      $project: {
        _id: 0,
        clauseId: 1,
        productType: 1,
        heading: 1,
        text: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ];

  const results = await collection.aggregate(pipeline).toArray();

  return results.map((doc) => ({
    clauseId: String(doc.clauseId),
    productType: String(doc.productType || productType),
    heading: String(doc.heading || ''),
    text: String(doc.text || ''),
    score: typeof doc.score === 'number' ? doc.score : 0,
  }));
}

/**
 * Index (or re-index) the clauses of a product wording document.  Upserts
 * into the `policy_wording_clauses` collection using the clauseId as the
 * natural key.  Run when a wording is published or amended.
 */
export async function indexPolicyWording(
  productType: string,
  clauses: { clauseId: string; heading: string; text: string }[],
): Promise<number> {
  const vectors = await embedClauses(clauses.map((clause) => clause.text));

  const collection = getPolicyWordingCollection();

  const operations = clauses.map((clause, index) => ({
    updateOne: {
      filter: { clauseId: clause.clauseId },
      update: {
        $set: {
          clauseId: clause.clauseId,
          productType,
          heading: clause.heading,
          text: clause.text,
          embedding: vectors[index],
        },
      },
      upsert: true,
    },
  }));

  await collection.bulkWrite(operations);

  return clauses.length;
}

// Re-export the collection name so callers that need to reference it directly
// (e.g. for index creation scripts) do not need to import from the client file.
export { POLICY_WORDING_COLLECTION };
