/**
 * Atlas Vector Search client.
 *
 * Policy-wording clause embeddings are stored in the `policywording` collection
 * on the same Atlas cluster as the claims data. A vector search index named
 * `policy_wording_vector_index` must be created on the `embedding` field of
 * that collection before this client is used.
 *
 * This module replaces the previous Pinecone integration. Keeping embeddings
 * inside Atlas eliminates the operational overhead of a separate vector index
 * service and allows MongoDB's built-in $vectorSearch aggregation stage to be
 * used directly — consistent with the Atlas best practice of preferring native
 * query capabilities over external search engines.
 *
 * Environment variables:
 *   MONGODB_URI          – Atlas connection string (already required by the app)
 *   ATLAS_VECTOR_DB      – database that holds the policy-wording collection
 *                          (defaults to the database in MONGODB_URI, or
 *                          "claims" if not determinable)
 *   ATLAS_VECTOR_COLLECTION – collection name (default: "policywording")
 *   ATLAS_VECTOR_INDEX      – vector search index name
 *                             (default: "policy_wording_vector_index")
 */

export const ATLAS_VECTOR_COLLECTION =
  process.env.ATLAS_VECTOR_COLLECTION || 'policywording';

export const ATLAS_VECTOR_INDEX =
  process.env.ATLAS_VECTOR_INDEX || 'policy_wording_vector_index';
