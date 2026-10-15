import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Field-level encryption helpers (AES-256-GCM)
// ---------------------------------------------------------------------------
// The key must be a 32-byte value supplied via FIELD_ENCRYPTION_KEY (hex).
// Each encrypted value is stored as:  <12-byte IV>:<16-byte auth-tag>:<ciphertext>
// all base64url-encoded and joined with colons so the envelope is a plain
// string that MongoDB can index on equality if needed.
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

function getEncryptionKey(): Buffer {
  const hex = process.env.FIELD_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'FIELD_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
        'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return Buffer.from(hex, 'hex');
}

export function encryptField(plain: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptField(envelope: string): string {
  const key = getEncryptionKey();
  const parts = envelope.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted field envelope');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const ciphertext = Buffer.from(ctB64, 'base64url');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Mongoose getter/setter pair for a nullable encrypted string field. */
const encryptedStringOptions = {
  type: String,
  default: null,
  get(stored: string | null): string | null {
    if (stored === null || stored === undefined) return null;
    try {
      return decryptField(stored);
    } catch {
      // Return null rather than surfacing a decryption error to callers;
      // the service layer should treat this as missing data.
      return null;
    }
  },
  set(plain: string | null): string | null {
    if (plain === null || plain === undefined) return null;
    return encryptField(plain);
  },
};

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

  @Prop({ required: true })
  customerId: string;

  @Prop({ required: true })
  productType: string;

  @Prop({ required: true })
  claimantName: string;

  /**
   * PII – stored encrypted at rest (AES-256-GCM). The getter/setter pair
   * transparently encrypts on write and decrypts on read.
   */
  @Prop(encryptedStringOptions)
  claimantEmail: string;

  /**
   * PII – stored encrypted at rest (AES-256-GCM).
   */
  @Prop(encryptedStringOptions)
  dateOfBirth: string | null;

  @Prop({ required: true })
  dateOfLoss: string;

  @Prop({ required: true })
  lossType: string;

  @Prop({ required: true })
  incidentNarrative: string;

  /**
   * Free-text medical notes supplied on bodily-injury claims. Health data:
   * stored encrypted at rest (AES-256-GCM), read by the triage agent, never
   * returned in list responses.
   */
  @Prop(encryptedStringOptions)
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

// Ensure getters are applied when converting to plain objects / JSON so that
// the decrypted values are returned by .lean() calls and toObject().
ClaimSchema.set('toObject', { getters: true });
ClaimSchema.set('toJSON', { getters: true });
