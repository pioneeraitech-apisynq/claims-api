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
   * SECURITY — PHI / field-level encryption required:
   * This field must be encrypted at rest using MongoDB Atlas Client-Side Field
   * Level Encryption (CSFLE) / Queryable Encryption with a Customer-Managed Key
   * (CMK) before this service is deployed to production. Configure the
   * `MongoClient` (or Mongoose connection) with an `autoEncryption` descriptor
   * that specifies the `claims.medicalNotes` field and your KMS provider
   * (e.g. AWS KMS key ARN in `AWS_REGION`). Until CSFLE is wired in, this
   * field MUST NOT be populated in any environment that can be reached from the
   * internet. See: https://www.mongodb.com/docs/manual/core/csfle/
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
