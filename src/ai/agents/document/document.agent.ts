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
 * Uses AI SDK Core's generateObject (via @ai-sdk/anthropic) so the agent
 * benefits from unified error types, abort-signal propagation, SDK-level
 * retries, and middleware support — instead of calling the raw Anthropic SDK.
 */

export const DOCUMENT_EXTRACTION_MODEL = 'claude-sonnet-4-5';

/**
 * Gateway-aware Anthropic provider.
 *
 * Point ANTHROPIC_BASE_URL at the APISynQ AI gateway to route every Anthropic
 * call through it without a code change, mirroring the OpenAI provider.
 */
const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  ...(process.env.ANTHROPIC_BASE_URL
    ? { baseURL: process.env.ANTHROPIC_BASE_URL }
    : {}),
});

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
 */
export async function runDocumentExtractionAgent(
  filename: string,
  contentType: string,
  text: string,
): Promise<DocumentExtractionOutput> {
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
