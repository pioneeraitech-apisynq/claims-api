import { createAnthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import {
  DOCUMENT_EXTRACTION_SYSTEM_PROMPT,
  buildDocumentExtractionPrompt,
} from './document.prompt';

/**
 * Claim document extraction agent.
 *
 * Runs Anthropic claude-sonnet-4-5 over the text of an uploaded claim document
 * and returns the fields the adjuster and the triage agent need: who issued it,
 * when, what it totals, and whether it carries medical data.
 *
 * The model is accessed through the AI SDK `@ai-sdk/anthropic` provider so
 * that all model traffic shares the same observable, gateway-routable path as
 * the triage agent rather than reaching the Anthropic API directly.
 */

export const DOCUMENT_EXTRACTION_MODEL = 'claude-sonnet-4-5';

/**
 * Lazy singleton for the Anthropic AI SDK provider.
 * The base URL is read from ANTHROPIC_BASE_URL so the same gateway-routing
 * pattern used for OpenAI traffic can be applied here too.
 */
let _anthropic: ReturnType<typeof createAnthropic> | null = null;

function getAnthropicProvider(): ReturnType<typeof createAnthropic> {
  if (!_anthropic) {
    _anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      ...(process.env.ANTHROPIC_BASE_URL
        ? { baseURL: process.env.ANTHROPIC_BASE_URL }
        : {}),
    });
  }
  return _anthropic;
}

export const documentExtractionSchema = z.object({
  documentType: z.enum([
    'invoice',
    'estimate',
    'police_report',
    'medical_report',
    'receipt',
    'unknown',
  ]),
  issuer: z.string().nullable(),
  documentDate: z.string().nullable(),
  referenceNumber: z.string().nullable(),
  totalAmountCents: z.number().int().nullable(),
  currency: z.string().nullable(),
  lineItems: z
    .array(
      z.object({
        description: z.string(),
        amountCents: z.number().int().nullable(),
      }),
    )
    .default([]),
  summary: z.string().nullable(),
  containsMedicalData: z.boolean(),
});

export type DocumentExtraction = z.infer<typeof documentExtractionSchema>;

export interface DocumentExtractionOutput extends DocumentExtraction {
  model: string;
}

/**
 * Extract fields from one claim document. The caller passes the document's text
 * layer; binary formats are converted upstream.
 *
 * Uses `generateObject` with the AI SDK Anthropic provider so schema validation
 * and structured output are handled by the SDK rather than a manual JSON parse.
 */
export async function runDocumentExtractionAgent(
  filename: string,
  contentType: string,
  text: string,
): Promise<DocumentExtractionOutput> {
  const anthropic = getAnthropicProvider();

  const { object } = await generateObject({
    model: anthropic(DOCUMENT_EXTRACTION_MODEL),
    schema: documentExtractionSchema,
    system: DOCUMENT_EXTRACTION_SYSTEM_PROMPT,
    prompt: buildDocumentExtractionPrompt(filename, contentType, text),
    temperature: 0,
    maxRetries: 2,
  });

  return {
    ...object,
    model: DOCUMENT_EXTRACTION_MODEL,
  };
}
