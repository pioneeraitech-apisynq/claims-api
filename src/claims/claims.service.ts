import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { Claim, ClaimDocument } from './schemas/claim.schema';
import { CreateClaimDto } from './dto/create-claim.dto';
import { SettleClaimDto } from './dto/settle-claim.dto';
import { TriageClaimDto } from './dto/triage-claim.dto';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { getPolicy, getPolicyCoverage } from '../clients/policy-api.client';
import {
  createSettlementPayout,
  getPayment,
} from '../clients/payment-api.client';
import { putClaimDocument } from '../storage/s3.client';
import {
  acquireTriageLock,
  readCachedTriage,
  releaseTriageLock,
  writeCachedTriage,
} from '../cache/redis.client';
import {
  runTriageAgent,
  type TriageAgentOutput,
} from '../ai/agents/triage/triage.agent';
import { runDocumentExtractionAgent } from '../ai/agents/document/document.agent';

@Injectable()
export class ClaimsService {
  constructor(
    @InjectModel(Claim.name) private readonly claimModel: Model<ClaimDocument>,
  ) {}

  /**
   * File a claim. The policy is verified against the Policy API first: a claim
   * cannot be filed against a policy that does not exist, was never activated,
   * or was cancelled before the date of loss.
   */
  async create(dto: CreateClaimDto): Promise<Claim> {
    const policy = await getPolicy(dto.policyNumber).catch(() => null);

    if (!policy) {
      throw new BadRequestException(
        `Policy ${dto.policyNumber} not found in the Policy API`,
      );
    }

    if (policy.status === 'cancelled' || policy.status === 'declined') {
      throw new BadRequestException(
        `Policy ${dto.policyNumber} is ${policy.status}; no claim can be filed against it`,
      );
    }

    if (new Date(dto.dateOfLoss) < new Date(policy.createdAt)) {
      throw new BadRequestException(
        'Date of loss precedes the policy inception date',
      );
    }

    const claim = await this.claimModel.create({
      claimId: randomUUID(),
      policyNumber: dto.policyNumber,
      customerId: policy.customerId,
      productType: policy.productType,
      claimantName: dto.claimantName,
      claimantEmail: dto.claimantEmail,
      dateOfBirth: dto.dateOfBirth ?? null,
      dateOfLoss: dto.dateOfLoss,
      lossType: dto.lossType,
      incidentNarrative: dto.incidentNarrative,
      medicalNotes: dto.medicalNotes ?? null,
      claimedAmountCents: dto.claimedAmountCents,
      currency: dto.currency ?? 'usd',
      status: 'filed',
      documents: [],
      triage: null,
      settlement: null,
    });

    return claim.toObject();
  }

  async findOne(claimId: string): Promise<Claim> {
    const claim = await this.claimModel.findOne({ claimId }).lean().exec();
    if (!claim) {
      throw new NotFoundException(`Claim ${claimId} not found`);
    }
    return claim;
  }

  /**
   * List claims, optionally narrowed to one policy. Medical notes are projected
   * out: health data is never returned in a list response.
   */
  async list(policyNumber?: string): Promise<Claim[]> {
    const filter = policyNumber ? { policyNumber } : {};
    return this.claimModel
      .find(filter, { medicalNotes: 0 })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean()
      .exec();
  }

  /**
   * Upload a claim document. The bytes go to S3; the document extraction agent
   * reads the supplied text layer and the extracted fields are stored alongside
   * the object key.
   */
  async addDocument(claimId: string, dto: UploadDocumentDto) {
    const claim = await this.findOne(claimId);

    const body = Buffer.from(dto.content, 'base64');
    const stored = await putClaimDocument(
      claim.claimId,
      dto.filename,
      dto.contentType,
      body,
    );

    const extraction = await runDocumentExtractionAgent(
      dto.filename,
      dto.contentType,
      dto.text,
    );

    const document = {
      documentId: stored.documentId,
      filename: dto.filename,
      contentType: dto.contentType,
      s3Key: stored.s3Key,
      sizeBytes: stored.sizeBytes,
      uploadedAt: new Date().toISOString(),
      extraction: extraction as unknown as Record<string, unknown>,
    };

    await this.claimModel
      .updateOne({ claimId }, { $push: { documents: document } })
      .exec();

    return document;
  }

  /**
   * Run the triage agent over a claim.
   *
   * A Redis lock keeps two concurrent calls from running the model twice, and
   * the result is cached under the claim id so a repeat call inside the TTL is
   * served without another model call.
   */
  async triage(
    claimId: string,
    dto: TriageClaimDto,
  ): Promise<TriageAgentOutput> {
    const claim = await this.findOne(claimId);

    if (!dto.force) {
      const cached = await readCachedTriage<TriageAgentOutput>(claimId);
      if (cached) {
        return cached;
      }
    }

    const locked = await acquireTriageLock(claimId);
    if (!locked) {
      throw new ConflictException(`Claim ${claimId} is already being triaged`);
    }

    try {
      const [policy, coverage] = await Promise.all([
        getPolicy(claim.policyNumber),
        getPolicyCoverage(claim.policyNumber),
      ]);

      const result = await runTriageAgent({
        claimId: claim.claimId,
        policyNumber: claim.policyNumber,
        productType: policy.productType,
        claimantName: claim.claimantName,
        claimantEmail: claim.claimantEmail,
        dateOfBirth: claim.dateOfBirth ?? undefined,
        dateOfLoss: claim.dateOfLoss,
        lossType: claim.lossType,
        incidentNarrative: claim.incidentNarrative,
        medicalNotes: claim.medicalNotes ?? undefined,
        claimedAmountCents: claim.claimedAmountCents,
        coverageAmountCents: policy.coverageAmountCents,
        currency: coverage.currency,
        fastTrackThresholdCents: dto.fastTrackThresholdCents,
      });

      await this.claimModel
        .updateOne(
          { claimId },
          {
            $set: {
              triage: { ...result, triagedAt: new Date().toISOString() },
              status: result.requiresHumanAdjuster
                ? 'awaiting_adjuster'
                : 'triaged',
            },
          },
        )
        .exec();

      await writeCachedTriage(claimId, result);
      return result;
    } finally {
      await releaseTriageLock(claimId);
    }
  }

  /**
   * Settle a claim. The payout is capped at the policy's coverage limit and
   * booked through the Payment API, which owns the money movement.
   */
  async settle(claimId: string, dto: SettleClaimDto) {
    const claim = await this.findOne(claimId);

    if (claim.settlement) {
      throw new ConflictException(`Claim ${claimId} is already settled`);
    }

    if (!claim.triage) {
      throw new BadRequestException(
        `Claim ${claimId} must be triaged before it can be settled`,
      );
    }

    if (claim.triage.requiresHumanAdjuster && !dto.approvedBy) {
      throw new BadRequestException(
        `Claim ${claimId} needs an adjuster approval; supply approvedBy`,
      );
    }

    const policy = await getPolicy(claim.policyNumber);
    const requested = dto.amountCents ?? claim.triage.recommendedPayoutCents;
    const amountCents = Math.min(requested, policy.coverageAmountCents);

    if (amountCents <= 0) {
      throw new BadRequestException('Settlement amount must be positive');
    }

    const payout = await createSettlementPayout({
      policyId: claim.policyNumber,
      customerId: claim.customerId,
      amountCents,
      currency: claim.currency,
      paymentMethodId: dto.paymentMethodId,
    });

    // Read the payment back so a payout parked on 3DS is not recorded as paid.
    const confirmed = await getPayment(payout.id);

    const settlement = {
      paymentId: confirmed.id,
      amountCents: confirmed.amountCents,
      currency: confirmed.currency,
      status: confirmed.status,
      settledAt: new Date().toISOString(),
    };

    await this.claimModel
      .updateOne(
        { claimId },
        {
          $set: {
            settlement,
            status: confirmed.status === 'succeeded' ? 'settled' : 'approved',
          },
        },
      )
      .exec();

    return settlement;
  }
}
