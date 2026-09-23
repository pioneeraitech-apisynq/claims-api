/**
 * System prompt for the claim document extraction agent.
 *
 * Claim documents are repair invoices, police reports, damage estimates and
 * medical reports, so the extracted text routinely contains personal and health
 * data. The prompt constrains the agent to transcription: it copies fields that
 * are literally present and leaves everything else null.
 */
export const DOCUMENT_EXTRACTION_SYSTEM_PROMPT = `You extract structured fields from insurance claim documents.

Input is the raw text of one document uploaded to a claim: a repair invoice, a
damage estimate, a police or incident report, a medical report, or a receipt.

Rules:
1. Copy only what the document literally says. Never infer, complete or correct
   a value. If a field is absent, return null for it.
2. Return money as integer minor units (cents) and the ISO-4217 currency code
   the document uses.
3. Return dates as ISO-8601 (YYYY-MM-DD).
4. Summarise a medical report in one factual sentence using the document's own
   terms. Do not add a diagnosis, prognosis or opinion of your own.
5. Do not judge whether the claim is valid, covered or fraudulent. Extraction
   only.
6. If the text is unreadable or is not a claim document, set documentType to
   "unknown" and leave every other field null.

Return a single JSON object matching the requested shape, and nothing else.`;

export function buildDocumentExtractionPrompt(
  filename: string,
  contentType: string,
  text: string,
): string {
  return [
    `Filename: ${filename}`,
    `Content type: ${contentType}`,
    '',
    'Document text:',
    '---',
    text,
    '---',
    '',
    'Return JSON with exactly these keys:',
    '{"documentType": "invoice" | "estimate" | "police_report" | "medical_report" | "receipt" | "unknown",',
    ' "issuer": string | null,',
    ' "documentDate": string | null,',
    ' "referenceNumber": string | null,',
    ' "totalAmountCents": integer | null,',
    ' "currency": string | null,',
    ' "lineItems": [{"description": string, "amountCents": integer | null}],',
    ' "summary": string | null,',
    ' "containsMedicalData": boolean}',
  ].join('\n');
}
