import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Field-level encryption helpers for medicalNotes (PHI / health data).
//
// MEDICAL_NOTES_KEY must be a 32-byte (256-bit) hex-encoded secret stored in
// your secrets manager and injected via environment variable. If absent the
// service refuses to handle medical notes.  Algorithm: AES-256-GCM with a
// random 96-bit IV prepended to the ciphertext, followed by the 16-byte auth
// tag – all base64-encoded as a single string so storage is transparent.
//
// Format: base64( iv[12] || tag[16] || ciphertext )
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function getMedicalNotesKey(): Buffer {
  const hex = process.env.MEDICAL_NOTES_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'MEDICAL_NOTES_KEY environment variable must be a 64-char hex string ' +
        '(32 bytes / 256-bit AES key). Set it in your secrets manager.',
    );
  }
  return Buffer.from(hex, 'hex');
}

export function encryptMedicalNotes(plaintext: string): string {
  const key = getMedicalNotesKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptMedicalNotes(ciphertext: string): string {
  const key = getMedicalNotesKey();
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const encrypted = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return (
    decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8')
  );
}

// ---------------------------------------------------------------------------

export type ClaimStatus =
  | 'filed'
  | 'triaged'
  | 'awaiting_adjuster'
  | 'approved'
  | 'declined'
  | 'settled';

@Schema({ _id: false })
export class ClaimDocumentFile {
  @Prop({ required: true })
  documentId: string;

  @Prop({ required: true })
  filename: string;

  @Prop({ required: true })
  contentType: string;

  /** S3 object key. The bytes themselves are never stored in MongoDB. */
  @Prop({ required: true })
  s3Key: string;

  @Prop({ required: true })
  sizeBytes: number;

  @Prop({ required: true })
  uploadedAt: string;

  /** Output of the document extraction agent, when it ran. */
  @Prop({ type: Object, default: null })
  extraction: Record<string, unknown> | null;
}

@Schema({ _id: false })
export class ClaimTriage {
  @Prop({ required: true })
  recommendation: string;

  @Prop({ required: true })
  severity: string;

  @Prop({ required: true })
  coveredUnderPolicy: boolean;

  @Prop({ default: null })
  citedClauseId: string | null;

  @Prop({ default: null })
  quotedClause: string | null;

  @Prop({ required: true })
  recommendedPayoutCents: number;

  @Prop({ type: [String], default: [] })
  fraudIndicators: string[];

  @Prop({ required: true })
  requiresHumanAdjuster: boolean;

  @Prop({ type: [String], default: [] })
  missingInformation: string[];

  @Prop({ required: true })
  rationale: string;

  @Prop({ required: true })
  confidence: number;

  @Prop({ required: true })
  model: string;

  @Prop({ type: [String], default: [] })
  retrievedClauseIds: string[];

  @Prop({ required: true })
  triagedAt: string;
}

@Schema({ _id: false })
export class ClaimSettlement {
  @Prop({ required: true })
  paymentId: string;

  @Prop({ required: true })
  amountCents: number;

  @Prop({ required: true })
  currency: string;

  @Prop({ required: true })
  status: string;

  @Prop({ required: true })
  settledAt: string;
}

@Schema({ collection: 'claims', timestamps: true })
export class Claim {
  @Prop({ required: true, unique: true, index: true })
  claimId: string;

  @Prop({ required: true, index: true })
  policyNumber: string;

  @Prop({ required: true, index: true })
  customerId: string;

  @Prop({ required: true })
  productType: string;

  @Prop({ required: true })
  claimantName: string;

  @Prop({ required: true })
  claimantEmail: string;

  @Prop({ default: null })
  dateOfBirth: string | null;

  @Prop({ required: true })
  dateOfLoss: string;

  @Prop({ required: true })
  lossType: string;

  @Prop({ required: true })
  incidentNarrative: string;

  /**
   * Free-text medical notes supplied on bodily-injury claims. Health data: read
   * by the triage agent, never returned in list responses.
   *
   * Stored as AES-256-GCM ciphertext (base64). Use encryptMedicalNotes /
   * decryptMedicalNotes from this module to read or write the value.
   */
  @Prop({ default: null })
  medicalNotes: string | null;

  @Prop({ required: true })
  claimedAmountCents: number;

  @Prop({ required: true, default: 'usd' })
  currency: string;

  @Prop({ required: true, default: 'filed', index: true })
  status: ClaimStatus;

  @Prop({ type: [Object], default: [] })
  documents: ClaimDocumentFile[];

  @Prop({ type: Object, default: null })
  triage: ClaimTriage | null;

  @Prop({ type: Object, default: null })
  settlement: ClaimSettlement | null;
}

export type ClaimDocument = HydratedDocument<Claim>;

export const ClaimSchema = SchemaFactory.createForClass(Claim);
