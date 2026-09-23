import {
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export const LOSS_TYPES = [
  'collision',
  'theft',
  'fire',
  'water_damage',
  'bodily_injury',
  'third_party_liability',
] as const;

export class CreateClaimDto {
  @IsString()
  @MaxLength(64)
  policyNumber: string;

  @IsString()
  @MaxLength(120)
  claimantName: string;

  @IsEmail()
  claimantEmail: string;

  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @IsDateString()
  dateOfLoss: string;

  @IsIn(LOSS_TYPES as unknown as string[])
  lossType: string;

  @IsString()
  @MinLength(20)
  @MaxLength(4000)
  incidentNarrative: string;

  /**
   * Health data. Supplied on bodily-injury claims and read by the triage agent.
   */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  medicalNotes?: string;

  @IsInt()
  @IsPositive()
  claimedAmountCents: number;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;
}
