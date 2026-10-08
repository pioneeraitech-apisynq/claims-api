import mongoose from 'mongoose';
import { embedClauses, embedQuery } from './embeddings';
import { ATLAS_VECTOR_COLLECTION, ATLAS_VECTOR_INDEX } from './pinecone.client';

/**
 * Retrieval-augmented search over policy wording using MongoDB Atlas native
 * vector search.
 *
 * The claim narrative is embedded and matched against clause embeddings stored
 * in the `policywording` Atlas collection via the $vectorSearch aggregation
 * stage. The top clauses are handed to the triage agent so its decision cites
 * the wording it relied on rather than inventing one.
 *
 * This replaces the previous Pinecone-backed implementation. Atlas vector
 * search keeps the entire data tier within a single cluster and removes the
 * operational complexity of a separate vector index service.
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

  const db = mongoose.connection.db;
  const collection = db.collection(ATLAS_VECTOR_COLLECTION);

  // $vectorSearch is the Atlas native aggregation stage for ANN vector search.
  // The `filter` field applies an exact pre-filter on productType so only
  // clauses from the correct product wording are returned.
  const results = await collection
    .aggregate([
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
    ])
    .toArray();

  return results.map((doc) => ({
    clauseId: String(doc.clauseId ?? ''),
    productType: String(doc.productType ?? productType),
    heading: String(doc.heading ?? ''),
    text: String(doc.text ?? ''),
    score: typeof doc.score === 'number' ? doc.score : 0,
  }));
}

/**
 * Index (or re-index) the clauses of a product wording document. Run when a
 * wording is published or amended.
 */
export async function indexPolicyWording(
  productType: string,
  clauses: { clauseId: string; heading: string; text: string }[],
): Promise<number> {
  const vectors = await embedClauses(clauses.map((clause) => clause.text));

  const db = mongoose.connection.db;
  const collection = db.collection(ATLAS_VECTOR_COLLECTION);

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

  if (operations.length > 0) {
    await collection.bulkWrite(operations);
  }

  return clauses.length;
}
