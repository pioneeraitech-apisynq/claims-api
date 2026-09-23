import { randomUUID } from 'crypto';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * Claim documents (photos of damage, repair invoices, police reports, medical
 * reports) are stored in S3. Only the object key is written to MongoDB; the
 * bytes never live in the database.
 */
let s3: S3Client | null = null;

function getS3(): S3Client {
  if (!s3) {
    s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
  }
  return s3;
}

function bucket(): string {
  return process.env.CLAIM_DOCUMENTS_BUCKET || 'digital-insurance-claim-docs';
}

export interface StoredDocument {
  documentId: string;
  s3Key: string;
  sizeBytes: number;
}

/**
 * Upload a claim document. Returns the generated document id and object key.
 */
export async function putClaimDocument(
  claimId: string,
  filename: string,
  contentType: string,
  body: Buffer,
): Promise<StoredDocument> {
  const documentId = randomUUID();
  const s3Key = `claims/${claimId}/${documentId}/${filename}`;

  await getS3().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: s3Key,
      Body: body,
      ContentType: contentType,
      ServerSideEncryption: 'AES256',
      Metadata: { claimId, documentId },
    }),
  );

  return { documentId, s3Key, sizeBytes: body.length };
}

/**
 * Read a claim document back out of S3, for example so the document extraction
 * agent can read its text.
 */
export async function getClaimDocument(s3Key: string): Promise<Buffer> {
  const result = await getS3().send(
    new GetObjectCommand({ Bucket: bucket(), Key: s3Key }),
  );

  const chunks: Buffer[] = [];
  for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
