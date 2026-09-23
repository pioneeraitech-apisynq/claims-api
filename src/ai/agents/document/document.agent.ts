import Anthropic from '@anthropic-ai/sdk';
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

let anthropic: Anthropic | null = null;

function getAnthropic(): Anthropic {
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
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
  const message = await getAnthropic().messages.create({
    model: DOCUMENT_EXTRACTION_MODEL,
    max_tokens: 2048,
    temperature: 0,
    system: DOCUMENT_EXTRACTION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: buildDocumentExtractionPrompt(filename, contentType, text),
      },
    ],
  });

  const block = message.content.find((part) => part.type === 'text');
  const raw = block && block.type === 'text' ? block.text : '';

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
