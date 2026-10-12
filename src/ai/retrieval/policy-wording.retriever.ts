import { type LanguageModelV2, type LanguageModelV2Middleware } from 'ai';
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
 * AI SDK Language Model Middleware that performs policy-wording RAG.
 *
 * Wrap any model with this middleware and the retrieval step is handled
 * transparently before the first prompt token is sent — the model never
 * sees a prompt without its relevant wording clauses, and the call site
 * needs no knowledge of Pinecone at all.
 *
 * Usage:
 *   import { wrapLanguageModel } from 'ai';
 *   import { createPolicyWordingMiddleware } from '...';
 *
 *   const model = wrapLanguageModel({
 *     model: openai(TRIAGE_MODEL),
 *     middleware: createPolicyWordingMiddleware(productType),
 *   });
 */
export function createPolicyWordingMiddleware(
  productType: string,
  topK = 4,
): LanguageModelV2Middleware {
  return {
    middlewareVersion: 'v2',

    async wrapGenerate({ doGenerate, params }) {
      const clauses = await retrieveClausesFromPrompt(
        params,
        productType,
        topK,
      );

      const augmentedParams = augmentParamsWithClauses(params, clauses);

      const result = await doGenerate(augmentedParams);

      return {
        ...result,
        providerMetadata: {
          ...result.providerMetadata,
          policyWordingRetrieval: {
            retrievedClauseIds: clauses.map((c) => c.clauseId),
          },
        },
      };
    },

    async wrapStream({ doStream, params }) {
      const clauses = await retrieveClausesFromPrompt(
        params,
        productType,
        topK,
      );

      const augmentedParams = augmentParamsWithClauses(params, clauses);

      return doStream(augmentedParams);
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Pull the narrative text out of the last user message in the prompt so we
 * can embed it and query Pinecone without the call site having to pass the
 * raw narrative separately.
 */
function extractNarrativeFromParams(
  params: Parameters<LanguageModelV2Middleware['wrapGenerate']>[0]['params'],
): string {
  const messages = params.prompt ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') {
      const parts = Array.isArray(msg.content) ? msg.content : [];
      const text = parts
        .filter((p: { type: string }) => p.type === 'text')
        .map((p: { type: string; text: string }) => p.text)
        .join(' ');
      if (text) return text;
    }
  }
  return '';
}

async function retrieveClausesFromPrompt(
  params: Parameters<LanguageModelV2Middleware['wrapGenerate']>[0]['params'],
  productType: string,
  topK: number,
): Promise<PolicyClause[]> {
  const narrative = extractNarrativeFromParams(params);
  if (!narrative) return [];
  return searchPolicyWording(narrative, productType, topK);
}

function formatClauses(clauses: PolicyClause[]): string {
  if (!clauses.length) {
    return 'No policy wording clauses were retrieved for this product.';
  }
  return clauses
    .map((c) => `[${c.clauseId}] ${c.heading}\n${c.text}`)
    .join('\n\n');
}

/**
 * Append the retrieved wording to the system prompt so it is always present
 * regardless of how the individual call site builds its messages.
 */
function augmentParamsWithClauses(
  params: Parameters<LanguageModelV2Middleware['wrapGenerate']>[0]['params'],
  clauses: PolicyClause[],
): typeof params {
  const wordingBlock = `\n\nRetrieved policy wording:\n${formatClauses(clauses)}`;

  const messages = params.prompt ?? [];
  const systemIndex = messages.findIndex((m) => m.role === 'system');

  if (systemIndex !== -1) {
    const sys = messages[systemIndex];
    const existingText =
      Array.isArray(sys.content) && sys.content[0]?.type === 'text'
        ? sys.content[0].text
        : typeof sys.content === 'string'
          ? sys.content
          : '';

    const updatedMessages = [...messages];
    updatedMessages[systemIndex] = {
      ...sys,
      content: [{ type: 'text', text: existingText + wordingBlock }],
    };
    return { ...params, prompt: updatedMessages };
  }

  // No system message present — prepend one.
  return {
    ...params,
    prompt: [
      { role: 'system', content: [{ type: 'text', text: wordingBlock.trim() }] },
      ...messages,
    ],
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
