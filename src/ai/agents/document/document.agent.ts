import { generateObject } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
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
 */

export const DOCUMENT_EXTRACTION_MODEL = 'claude-sonnet-4-5';

let anthropicProvider: ReturnType<typeof createAnthropic> | null = null;

function getAnthropicProvider(): ReturnType<typeof createAnthropic> {
  if (!anthropicProvider) {
    anthropicProvider = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return anthropicProvider;
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
 */
export async function runDocumentExtractionAgent(
  filename: string,
  contentType: string,
  text: string,
): Promise<DocumentExtractionOutput> {
  const { object } = await generateObject({
    model: getAnthropicProvider()(DOCUMENT_EXTRACTION_MODEL),
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
