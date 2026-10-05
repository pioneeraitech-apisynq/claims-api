import { Pinecone } from '@pinecone-database/pinecone';

/**
 * Pinecone holds the vector index of policy wording: every clause of every
 * product wording document, chunked and embedded. The triage agent searches it
 * so its decision can quote the clause it relied on.
 */
let pinecone: Pinecone | null = null;

export function getPinecone(): Pinecone {
  if (!pinecone) {
    pinecone = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
      // Explicitly target the current stable API version (2026-07) to unlock
      // the Documents API, full-text search, and namespace aliases.
      apiVersion: '2026-07',
    });
  }
  return pinecone;
}

export function policyWordingIndex() {
  const indexName = process.env.PINECONE_INDEX || 'policy-wording';
  return getPinecone().index(indexName);
}

/**
 * The alias name configured in the Pinecone console (e.g. "policy-wording-current").
 * An alias lets us atomically repoint to a freshly-indexed namespace with no
 * downtime or redeployment (blue/green data swap).
 *
 * Falls back to the literal namespace value when no alias env var is set, so
 * existing deployments keep working without any console changes until the alias
 * is provisioned.
 */
const POLICY_WORDING_ALIAS =
  process.env.PINECONE_NAMESPACE_ALIAS || 'policy-wording-current';

const POLICY_WORDING_NAMESPACE_FALLBACK =
  process.env.PINECONE_NAMESPACE || 'policy-wording-v1';

/**
 * Resolves the active namespace for policy wording by looking up the alias
 * name via the Pinecone Namespaces API.  If the alias does not exist yet (e.g.
 * during initial setup) the raw fallback namespace is returned instead.
 */
export async function getPolicyWordingNamespace(): Promise<string> {
  try {
    const index = policyWordingIndex();
    const { namespaces } = await index.listNamespaces();
    const match = (namespaces ?? []).find(
      (ns) => ns.name === POLICY_WORDING_ALIAS,
    );
    if (match) {
      return POLICY_WORDING_ALIAS;
    }
  } catch {
    // If the API call fails for any reason, fall through to the static value
    // so query/upsert callers are never blocked.
  }
  return POLICY_WORDING_NAMESPACE_FALLBACK;
}
