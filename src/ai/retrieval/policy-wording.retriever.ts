import { type LanguageModelV1Middleware, wrapLanguageModel } from 'ai';
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

/**
 * Language Model Middleware that transparently injects retrieved policy wording
 * clauses into the prompt before the model is called.
 *
 * The caller sets `productType` once when wrapping the model; the middleware
 * extracts the claim narrative from the last user message, runs the Pinecone
 * similarity search, prepends the formatted clauses to that message, and
 * exposes the retrieved clause objects via the `retrievedClauses` symbol so
 * the agent can attach them to its output without re-running retrieval.
 *
 * Usage:
 *   const { model, getRetrievedClauses } = createPolicyWordingMiddleware(baseModel, productType);
 *   const { object } = await generateObject({ model, ... });
 *   const clauses = getRetrievedClauses();
 */
export function createPolicyWordingMiddleware(
  baseModel: Parameters<typeof wrapLanguageModel>[0]['model'],
  productType: string,
): {
  model: ReturnType<typeof wrapLanguageModel>;
  getRetrievedClauses: () => PolicyClause[];
} {
  let lastRetrievedClauses: PolicyClause[] = [];

  const middleware: LanguageModelV1Middleware = {
    transformParams: async ({ params }) => {
      // Extract the narrative from the last user turn.
      const messages = params.prompt;
      const lastUserMessage = [...messages]
        .reverse()
        .find((m) => m.role === 'user');

      const narrative =
        lastUserMessage?.content
          .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
          .map((part) => part.text)
          .join(' ') ?? '';

      const clauses = narrative
        ? await searchPolicyWording(narrative, productType)
        : [];

      lastRetrievedClauses = clauses;

      if (!clauses.length || !lastUserMessage) {
        return params;
      }

      const clauseBlock =
        '\n\nRetrieved policy wording:\n' +
        clauses
          .map((c) => `[${c.clauseId}] ${c.heading}\n${c.text}`)
          .join('\n\n');

      // Append the retrieved wording to the last user message.
      const augmentedMessages = params.prompt.map((message) => {
        if (message !== lastUserMessage) return message;
        return {
          ...message,
          content: [
            ...message.content,
            { type: 'text' as const, text: clauseBlock },
          ],
        };
      });

      return { ...params, prompt: augmentedMessages };
    },
  };

  return {
    model: wrapLanguageModel({ model: baseModel, middleware }),
    getRetrievedClauses: () => lastRetrievedClauses,
  };
}
