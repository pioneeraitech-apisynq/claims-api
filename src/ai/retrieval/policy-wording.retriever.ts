import { embedClauses, embedQuery } from './embeddings';
import { POLICY_WORDING_NAMESPACE, policyWordingIndex } from './pinecone.client';
import type { LanguageModelV2Middleware } from 'ai';

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
    .namespace(POLICY_WORDING_NAMESPACE)
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
 * Language Model Middleware that implements retrieval-augmented generation for
 * policy wording.
 *
 * When the agent prompt contains a `<!-- rag:narrative -->…<!-- /rag:narrative -->`
 * marker block the middleware extracts the narrative and productType, fetches
 * the relevant clauses from Pinecone, and injects a "Retrieved policy wording:"
 * section into the last user message before the model is called. This decouples
 * the retrieval concern from the agent call site and makes the middleware
 * reusable across any agent that needs policy-wording RAG.
 *
 * The caller embeds retrieval inputs using HTML-comment markers so that the
 * middleware can locate them without parsing unstructured prose:
 *
 *   <!-- rag:narrative -->…<!-- /rag:narrative -->
 *   <!-- rag:productType -->…<!-- /rag:productType -->
 *
 * The middleware removes the markers from the final prompt before forwarding
 * to the model so they never appear in the context the LLM sees.
 */
export function createPolicyWordingRagMiddleware(
  topK = 4,
): LanguageModelV2Middleware {
  return {
    wrapGenerate: async ({ doGenerate, params }) => {
      const messages = params.prompt;
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');

      if (!lastUser) {
        return doGenerate(params);
      }

      // Collect the full text content of the last user message.
      const textParts = lastUser.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n');

      const narrativeMatch = textParts.match(
        /<!--\s*rag:narrative\s*-->([\s\S]*?)<!--\s*\/rag:narrative\s*-->/,
      );
      const productTypeMatch = textParts.match(
        /<!--\s*rag:productType\s*-->([\s\S]*?)<!--\s*\/rag:productType\s*-->/,
      );

      if (!narrativeMatch || !productTypeMatch) {
        return doGenerate(params);
      }

      const narrative = narrativeMatch[1].trim();
      const productType = productTypeMatch[1].trim();

      const clauses = await searchPolicyWording(narrative, productType, topK);

      const wordingBlock = clauses.length
        ? clauses
            .map((clause) => `[${clause.clauseId}] ${clause.heading}\n${clause.text}`)
            .join('\n\n')
        : 'No policy wording clauses were retrieved for this product.';

      // Strip the RAG markers and append the retrieved wording.
      const cleanedText = textParts
        .replace(/<!--\s*rag:narrative\s*-->[\s\S]*?<!--\s*\/rag:narrative\s*-->/g, '')
        .replace(/<!--\s*rag:productType\s*-->[\s\S]*?<!--\s*\/rag:productType\s*-->/g, '')
        .trimEnd();

      const augmentedText = [
        cleanedText,
        '',
        'Retrieved policy wording:',
        wordingBlock,
      ].join('\n');

      // Rebuild the message list, replacing the last user message's text parts.
      const augmentedMessages = messages.map((m) => {
        if (m !== lastUser) return m;
        return {
          ...m,
          content: [
            ...m.content.filter((p) => p.type !== 'text'),
            { type: 'text' as const, text: augmentedText },
          ],
        };
      });

      return doGenerate({ ...params, prompt: augmentedMessages });
    },
  };
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

  await policyWordingIndex()
    .namespace(POLICY_WORDING_NAMESPACE)
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

  return clauses.length;
}
