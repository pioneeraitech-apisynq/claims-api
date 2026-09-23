import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ClaimsService } from './claims.service';
import { CreateClaimDto } from './dto/create-claim.dto';
import { ListClaimsQuery } from './dto/list-claims.query';
import { SettleClaimDto } from './dto/settle-claim.dto';
import { TriageClaimDto } from './dto/triage-claim.dto';
import { UploadDocumentDto } from './dto/upload-document.dto';

@Controller('v1/claims')
export class ClaimsController {
  constructor(private readonly claimsService: ClaimsService) {}

  // POST /v1/claims
  @Post()
  create(@Body() dto: CreateClaimDto) {
    return this.claimsService.create(dto);
  }

  // GET /v1/claims?policyNumber=
  @Get()
  list(@Query() query: ListClaimsQuery) {
    return this.claimsService.list(query.policyNumber);
  }

  // GET /v1/claims/:claimId
  @Get(':claimId')
  findOne(@Param('claimId') claimId: string) {
    return this.claimsService.findOne(claimId);
  }

  // POST /v1/claims/:claimId/documents
  @Post(':claimId/documents')
  addDocument(
    @Param('claimId') claimId: string,
    @Body() dto: UploadDocumentDto,
  ) {
    return this.claimsService.addDocument(claimId, dto);
  }

  // POST /v1/claims/:claimId/triage
  @Post(':claimId/triage')
  triage(@Param('claimId') claimId: string, @Body() dto: TriageClaimDto) {
    return this.claimsService.triage(claimId, dto);
  }

  // POST /v1/claims/:claimId/settle
  @Post(':claimId/settle')
  settle(@Param('claimId') claimId: string, @Body() dto: SettleClaimDto) {
    return this.claimsService.settle(claimId, dto);
  }
}
