import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
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
 * Uses the AI SDK's Anthropic provider so this agent shares the same
 * observability, retry, and middleware surfaces as every other agent in the
 * service, instead of bypassing the SDK via the raw @anthropic-ai/sdk client.
 */

export const DOCUMENT_EXTRACTION_MODEL = 'claude-sonnet-4-5';

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
  const { text: raw } = await generateText({
    model: anthropic(DOCUMENT_EXTRACTION_MODEL),
    system: DOCUMENT_EXTRACTION_SYSTEM_PROMPT,
    prompt: buildDocumentExtractionPrompt(filename, contentType, text),
    maxTokens: 2048,
    temperature: 0,
  });

  return {
    ...parseExtraction(raw),
    model: DOCUMENT_EXTRACTION_MODEL,
  };
}

/**
 * Parse the model's JSON answer. A model that answers with prose or with JSON
 * wrapped in a fence must not crash the upload, so an unparseable answer falls
 * back to an empty 'unknown' extraction.
 */
function parseExtraction(raw: string): DocumentExtraction {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();

  try {
    return documentExtractionSchema.parse(JSON.parse(candidate));
  } catch {
    return {
      documentType: 'unknown',
      issuer: null,
      documentDate: null,
      referenceNumber: null,
      totalAmountCents: null,
      currency: null,
      lineItems: [],
      summary: null,
      containsMedicalData: false,
    };
  }
}
