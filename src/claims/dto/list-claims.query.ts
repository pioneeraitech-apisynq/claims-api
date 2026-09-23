import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ListClaimsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  policyNumber?: string;
}
