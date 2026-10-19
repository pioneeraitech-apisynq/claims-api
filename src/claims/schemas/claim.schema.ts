import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

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
   * CSFLE: encrypted client-side with the KMS-managed data key before the
   * document is ever sent to MongoDB. The `encrypt` sub-document instructs the
   * MongoDB driver to apply Queryable Encryption / CSFLE using the key
   * referenced by MONGODB_MEDICAL_NOTES_KEY_ID and AEAD_AES_256_CBC_HMAC_SHA_512
   * deterministic algorithm (use "Random" if range/equality queries are not
   * required, which is the more privacy-preserving choice for free-text PHI).
   */
  @Prop({
    default: null,
    encrypt: {
      keyId: process.env.MONGODB_MEDICAL_NOTES_KEY_ID,
      algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random',
      bsonType: 'string',
    },
  })
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

/**
 * Compound index that covers:
 *   - list(policyNumber) → equality on policyNumber + descending sort on createdAt
 *   - list()            → descending sort on createdAt (index prefix scan)
 * Eliminates the full-collection in-memory sort flagged in finding 4.
 */
ClaimSchema.index({ policyNumber: 1, createdAt: -1 });
