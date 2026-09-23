import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { connect, disconnect, model } from 'mongoose';
import { z } from 'zod';
import { Claim, ClaimSchema } from '../claims/schemas/claim.schema';
import { getPolicy, getPolicyCoverage } from '../clients/policy-api.client';

/**
 * MCP server for the Claims API.
 *
 * Exposes the read-only claim tools an agent running elsewhere (an adjuster
 * copilot, a customer support assistant) needs: look up a claim by id, and look
 * up the coverage of the policy a claim was filed against. Both tools read
 * through the same MongoDB collection and the same Policy API client the HTTP
 * service uses, so an agent and a caller see the same data.
 *
 * Runs over stdio: `npm run start:mcp`.
 */

const ClaimModel = model<Claim>(Claim.name, ClaimSchema);

export const server = new McpServer({
  name: 'claims-api',
  version: '1.0.0',
});

server.tool(
  'lookup_claim',
  'Look up a claim by its claim id. Returns status, loss details, the triage recommendation if one has been produced, and the settlement if the claim has been paid.',
  { claimId: z.string().describe('The claim id, e.g. a UUID') },
  async ({ claimId }) => {
    const claim = await ClaimModel.findOne({ claimId }).lean().exec();

    if (!claim) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `No claim ${claimId}` }],
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              claimId: claim.claimId,
              policyNumber: claim.policyNumber,
              status: claim.status,
              lossType: claim.lossType,
              dateOfLoss: claim.dateOfLoss,
              claimedAmountCents: claim.claimedAmountCents,
              currency: claim.currency,
              documentCount: claim.documents?.length ?? 0,
              triage: claim.triage ?? null,
              settlement: claim.settlement ?? null,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'lookup_policy_coverage',
  'Look up the coverage limit and current premium quote of the policy a claim was filed against. Calls the internal Policy API.',
  {
    policyNumber: z
      .string()
      .describe('The policy number the claim was filed against'),
  },
  async ({ policyNumber }) => {
    const [policy, coverage] = await Promise.all([
      getPolicy(policyNumber),
      getPolicyCoverage(policyNumber),
    ]);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              policyNumber: policy.id,
              productType: policy.productType,
              status: policy.status,
              coverageAmountCents: policy.coverageAmountCents,
              termMonths: policy.termMonths,
              premiumCents: coverage.premiumCents,
              currency: coverage.currency,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

export async function start(): Promise<void> {
  await connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/claims');
  await server.connect(new StdioServerTransport());
}

if (require.main === module) {
  start().catch(async (error) => {
    // eslint-disable-next-line no-console
    console.error('claims-api MCP server failed to start', error);
    await disconnect();
    process.exit(1);
  });
}
