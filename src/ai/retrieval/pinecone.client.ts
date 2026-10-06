/**
 * MongoDB Atlas Vector Search client for policy-wording retrieval.
 *
 * This module replaces the former Pinecone integration.  Vectors are now
 * stored in the `policy_wording_clauses` collection of the same Atlas cluster
 * that holds claim documents, eliminating the external Pinecone dependency and
 * enabling co-located queries.
 *
 * Before this works you must create an Atlas Vector Search index on the
 * `policy_wording_clauses` collection with the following definition:
 *
 *   {
 *     "fields": [
 *       {
 *         "type": "vector",
 *         "path": "embedding",
 *         "numDimensions": 1536,
 *         "similarity": "cosine"
 *       },
 *       {
 *         "type": "filter",
 *         "path": "productType"
 *       }
 *     ]
 *   }
 *
 * Name the index "policy_wording_vector_index" (matches ATLAS_VECTOR_INDEX
 * below) and create it via the Atlas UI, Atlas CLI, or the Atlas Admin API.
 */

import mongoose, { Connection } from 'mongoose';

/** Name of the Atlas Vector Search index on the clauses collection. */
export const ATLAS_VECTOR_INDEX =
  process.env.ATLAS_VECTOR_INDEX || 'policy_wording_vector_index';

/** Collection that stores policy-wording clause embeddings. */
export const POLICY_WORDING_COLLECTION =
  process.env.POLICY_WORDING_COLLECTION || 'policy_wording_clauses';

/**
 * Returns the native MongoDB Collection for policy-wording clauses, obtained
 * from the active Mongoose default connection.  Throws if Mongoose is not yet
 * connected.
 */
export function getPolicyWordingCollection(conn?: Connection) {
  const connection = conn ?? mongoose.connection;
  if (connection.readyState !== 1) {
    throw new Error(
      'MongoDB connection is not open; cannot access policy_wording_clauses collection',
    );
  }
  return connection.db.collection(POLICY_WORDING_COLLECTION);
}
