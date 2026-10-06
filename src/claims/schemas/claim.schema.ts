import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ClaimStatus =
  | 'filed'
  | 'triaged'
  | 'awaiting_adjuster'
  | 'approved'
  | 'declined'
  | 'settled';

/**
 * MongoDB Client-Side Field Level Encryption (CSFLE) schema annotations.
 *
 * Each sensitive field below carries an `encrypt` option that the MongoDB
 * CSFLE-aware driver reads to encrypt the value on the client before it ever
 * reaches the server.  To activate CSFLE you must:
 *
 *  1. Create a Customer Master Key (CMK) in AWS KMS / Azure Key Vault / GCP KMS
 *     and store the Data Encryption Key (DEK) in the `__keyVault` collection.
 *  2. Pass `autoEncryption: { keyVaultNamespace, kmsProviders, schemaMap }`
 *     to the MongoClient (Mongoose `connectionFactory` option in forRoot).
 *  3. Use `algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic'` for
 *     fields you need to equality-query (e.g. claimantEmail) and
 *     `'AEAD_AES_256_CBC_HMAC_SHA_512-Random'` for free-text / nullable fields
 *     (e.g. medicalNotes, dateOfBirth) which do not need to be queried directly.
 *
 * The `encrypt` objects below follow the MongoDB JSON Schema encryption spec:
 * https://www.mongodb.com/docs/manual/reference/security-client-side-encryption-appendix/
 */

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
   * PII — encrypted at rest via CSFLE.
   * Deterministic algorithm allows equality queries (e.g. look up by email).
   * CSFLE schemaMap entry: { bsonType: 'string', algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic' }
   */
  @Prop({
    required: true,
    encrypt: {
      bsonType: 'string',
      algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic',
    },
  })
  claimantEmail: string;

  /**
   * PII — encrypted at rest via CSFLE.
   * Random algorithm used because direct equality queries on DOB are not required.
   * CSFLE schemaMap entry: { bsonType: 'string', algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random' }
   */
  @Prop({
    default: null,
    encrypt: {
      bsonType: 'string',
      algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random',
    },
  })
  dateOfBirth: string | null;

  @Prop({ required: true })
  dateOfLoss: string;

  @Prop({ required: true })
  lossType: string;

  @Prop({ required: true })
  incidentNarrative: string;

  /**
   * Protected Health Information (PHI) — encrypted at rest via CSFLE.
   * Free-text health data; random algorithm.  Never returned in list responses.
   * CSFLE schemaMap entry: { bsonType: 'string', algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random' }
   */
  @Prop({
    default: null,
    encrypt: {
      bsonType: 'string',
      algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random',
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
