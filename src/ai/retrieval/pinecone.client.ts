import { Pinecone } from '@pinecone-database/pinecone';

/**
 * Pinecone holds the vector index of policy wording: every clause of every
 * product wording document, chunked and embedded. The triage agent searches it
 * so its decision can quote the clause it relied on.
 */
let pinecone: Pinecone | null = null;

export function getPinecone(): Pinecone {
  if (!pinecone) {
    pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  }
  return pinecone;
}

export function policyWordingIndex() {
  const indexName = process.env.PINECONE_INDEX || 'policy-wording';
  return getPinecone().index(indexName);
}

/**
 * The stable alias name that all read traffic targets.
 *
 * With SDK v9 / API 2026-07 this becomes a real Pinecone namespace alias so
 * `flipPolicyWordingAlias` can atomically repoint it to the freshly written
 * shadow namespace with zero read downtime.  Until that upgrade the value is
 * used directly as the namespace name and reads/writes share the same
 * namespace, which is equivalent to the old behaviour.
 */
export const POLICY_WORDING_ALIAS =
  process.env.PINECONE_NAMESPACE_ALIAS || 'policy-wording-live';

/**
 * The namespace that `indexPolicyWording` writes into.
 *
 * During a re-index run set this to a shadow namespace (e.g.
 * `policy-wording-v2`) via the environment so writes never touch the live
 * read namespace mid-upsert.  After a successful run, call
 * `flipPolicyWordingAlias` to atomically repoint the alias.
 *
 * Defaults to the same value as `POLICY_WORDING_ALIAS` so that the service
 * behaves identically to before this change when no shadow namespace is
 * configured.
 */
export const POLICY_WORDING_WRITE_NAMESPACE =
  process.env.PINECONE_WRITE_NAMESPACE || POLICY_WORDING_ALIAS;

/**
 * Atomically repoints the `POLICY_WORDING_ALIAS` alias to
 * `POLICY_WORDING_WRITE_NAMESPACE`, completing a blue/green namespace swap.
 *
 * ⚠️  Requires `@pinecone-database/pinecone` v9+ and Pinecone API 2026-07.
 *    Uncomment the implementation block and remove the thrown error once the
 *    SDK has been upgraded.
 */
export async function flipPolicyWordingAlias(): Promise<void> {
  // TODO: uncomment after upgrading @pinecone-database/pinecone to v9+
  // const indexName = process.env.PINECONE_INDEX || 'policy-wording';
  // await getPinecone()
  //   .index(indexName)
  //   .updateNamespaceAlias(POLICY_WORDING_ALIAS, {
  //     namespace: POLICY_WORDING_WRITE_NAMESPACE,
  //   });

  throw new Error(
    'flipPolicyWordingAlias requires @pinecone-database/pinecone v9+ ' +
      '(API 2026-07). Upgrade the SDK and uncomment the implementation.',
  );
}
