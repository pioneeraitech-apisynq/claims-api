import { Pinecone } from '@pinecone-database/pinecone';

/**
 * Pinecone holds the vector index of policy wording: every clause of every
 * product wording document, chunked and embedded. The triage agent searches it
 * so its decision can quote the clause it relied on rather than inventing one.
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
 * The alias name used for all data-plane reads and writes.  Both
 * `searchPolicyWording` and `indexPolicyWording` call `.namespace()` with this
 * value.  Because it is a Pinecone namespace alias, the control plane can
 * atomically repoint it to a freshly-populated shadow namespace without any
 * code redeploy or read-window downtime (finding 2).
 */
export function getPolicyWordingAliasName(): string {
  return process.env.PINECONE_NAMESPACE_ALIAS || 'policy-wording';
}

/**
 * Create (or no-op if already present) the policy-wording index using the
 * schema-based body required by API 2026-07+.  Call once during deployment
 * bootstrap; do not use the legacy `dimension`/`metric`/`spec` top-level
 * fields (finding 4).
 */
export async function ensurePolicyWordingIndex(): Promise<void> {
  const pc = getPinecone();
  const indexName = process.env.PINECONE_INDEX || 'policy-wording';

  const { indexes } = await pc.listIndexes();
  const exists = (indexes ?? []).some((idx) => idx.name === indexName);
  if (exists) {
    return;
  }

  await pc.createIndex({
    name: indexName,
    schema: {
      fields: [
        {
          name: 'embedding',
          type: 'dense',
          dimension: Number(process.env.PINECONE_EMBEDDING_DIMENSION || 1536),
          metric: 'cosine',
        },
      ],
    },
    waitUntilReady: true,
  });
}

/**
 * Atomically repoint the policy-wording namespace alias to `targetNamespace`.
 * If the alias does not yet exist it is created; otherwise it is updated.
 * This enables blue/green data swaps: `indexPolicyWording` writes to a shadow
 * namespace and calls this once the write is verified (finding 2).
 */
export async function swapPolicyWordingNamespaceAlias(
  targetNamespace: string,
): Promise<void> {
  const pc = getPinecone();
  const indexName = process.env.PINECONE_INDEX || 'policy-wording';
  const aliasName = getPolicyWordingAliasName();

  const index = pc.index(indexName);

  // Try to update an existing alias; create it if not found.
  try {
    await index.updateNamespaceAlias(aliasName, { namespace: targetNamespace });
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status;
    if (status === 404) {
      await index.createNamespaceAlias(aliasName, {
        namespace: targetNamespace,
      });
    } else {
      throw err;
    }
  }
}
