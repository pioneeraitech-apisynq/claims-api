import { wrapLanguageModel, type LanguageModelV1 } from 'ai';
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
 * AI SDK Language Model Middleware that implements retrieval-augmented
 * generation for policy wording.
 *
 * Wrap any language model with this middleware and every `generateObject` /
 * `generateText` call will automatically embed the first user message,
 * retrieve the most relevant policy clauses from Pinecone, and prepend them to
 * the prompt — without the call site needing to know anything about retrieval.
 *
 * @example
 *   const ragModel = withPolicyWordingRAG(openai('gpt-4o-mini'), 'motor');
 *   const { object } = await generateObject({ model: ragModel, … });
 */
export function withPolicyWordingRAG(
  model: LanguageModelV1,
  productType: string,
  topK = 4,
): LanguageModelV1 {
  return wrapLanguageModel({
    model,
    middleware: {
      async transformParams({ params }) {
        // Extract the last user message text to use as the retrieval query.
        const messages = params.prompt ?? [];
        const lastUser = [...messages]
          .reverse()
          .find((m) => m.role === 'user');

        const query = lastUser?.content
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join(' ')
          .trim();

        if (!query) {
          return params;
        }

        const clauses = await searchPolicyWording(query, productType, topK);

        if (clauses.length === 0) {
          return params;
        }

        // Build an injected context block and prepend it to the prompt as a
        // synthetic user message so it is visible regardless of whether the
        // caller supplies a system prompt.
        const clauseBlock = clauses
          .map(
            (c) =>
              `[${c.clauseId}] ${c.heading}\n${c.text}`,
          )
          .join('\n\n');

        const contextMessage = {
          role: 'user' as const,
          content: [
            {
              type: 'text' as const,
              text: `Relevant policy wording clauses (retrieved):\n\n${clauseBlock}`,
            },
          ],
        };

        return {
          ...params,
          prompt: [contextMessage, ...messages],
        };
      },
    },
  });
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
