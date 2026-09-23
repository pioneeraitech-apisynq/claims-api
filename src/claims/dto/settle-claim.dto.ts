import { IsInt, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

export class SettleClaimDto {
  /**
   * Payout amount. Defaults to the triage agent's recommendation and is capped
   * at the policy's coverage limit either way.
   */
  @IsOptional()
  @IsInt()
  @IsPositive()
  amountCents?: number;

  /** The claimant's payout destination, held by the Payment API. */
  @IsString()
  @MaxLength(64)
  paymentMethodId: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  approvedBy?: string;
}
