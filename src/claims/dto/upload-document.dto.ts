import { IsBase64, IsIn, IsString, MaxLength } from 'class-validator';

export const DOCUMENT_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'text/plain',
] as const;

export class UploadDocumentDto {
  @IsString()
  @MaxLength(255)
  filename: string;

  @IsIn(DOCUMENT_CONTENT_TYPES as unknown as string[])
  contentType: string;

  /** The document bytes, base64 encoded. */
  @IsBase64()
  content: string;

  /**
   * The document's text layer. Supplied by the caller for PDFs and scans that
   * were OCR'd upstream; when present the extraction agent runs over it.
   */
  @IsString()
  @MaxLength(60000)
  text: string;
}
