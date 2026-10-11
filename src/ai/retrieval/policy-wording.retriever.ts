import type { LanguageModelMiddleware } from 'ai';
import { embedClauses, embedQuery } from './embeddings';
import { POLICY_WORDING_NAMESPACE, policyWordingIndex } from './pinecone.client';

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
 * AI SDK Language Model Middleware that injects relevant policy wording clauses
 * into the prompt before every model call.
 *
 * Usage:
 *   import { wrapLanguageModel } from 'ai';
 *   import { createPolicyWordingMiddleware } from '../../retrieval/policy-wording.retriever';
 *
 *   const model = wrapLanguageModel({
 *     model: openai(TRIAGE_MODEL),
 *     middleware: createPolicyWordingMiddleware(productType),
 *   });
 *
 * The middleware extracts the narrative from the last user message, retrieves
 * the top matching clauses from Pinecone, and prepends them to the prompt as a
 * system message so the model always cites real wording.
 */
export function createPolicyWordingMiddleware(
  productType: string,
  topK = 4,
): LanguageModelMiddleware {
  return {
    middlewareVersion: 'v2',
    async transformParams({ params }) {
      // Extract the narrative from the last user message so we can embed it.
      const messages = params.prompt ?? [];
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const narrative =
        lastUser?.content
          .filter((part) => part.type === 'text')
          .map((part) => (part as { type: 'text'; text: string }).text)
          .join(' ') ?? '';

      if (!narrative) {
        return { params };
      }

      const clauses = await searchPolicyWording(narrative, productType, topK);

      if (clauses.length === 0) {
        return { params };
      }

      const wordingBlock = clauses
        .map((clause) => `[${clause.clauseId}] ${clause.heading}\n${clause.text}`)
        .join('\n\n');

      const ragSystemMessage = {
        role: 'system' as const,
        content: `Retrieved policy wording for product "${productType}":\n\n${wordingBlock}`,
      };

      return {
        params: {
          ...params,
          prompt: [ragSystemMessage, ...messages],
        },
      };
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
