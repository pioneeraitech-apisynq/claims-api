import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

export class TriageClaimDto {
  /**
   * Re-run the triage agent even when a cached result for this claim is still
   * warm in Redis.
   */
  @IsOptional()
  @IsBoolean()
  force?: boolean;

  /** Claims at or below this amount may be recommended for fast track. */
  @IsOptional()
  @IsInt()
  @Min(0)
  fastTrackThresholdCents?: number;
}
