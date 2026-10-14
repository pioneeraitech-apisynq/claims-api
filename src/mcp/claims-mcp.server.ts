import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { z as zod } from 'zod';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Claim, ClaimDocument } from '../claims/schemas/claim.schema';
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
 *
 * Connection management: uses the NestJS application context (AppModule) so
 * that the same MongooseModule connection pool, TLS config, and authentication
 * credentials used by the HTTP server are reused here — no second, independently
 * configured connection is opened.
 *
 * PHI projection: the `medical` sub-document (containing free-text medical
 * notes and other health fields) is excluded from every query in this server.
 * MCP clients (adjuster copilot, customer support) must not receive raw health
 * data.
 */

/** Projection applied to every claim query in this server — strips all PHI. */
const NO_MEDICAL = { medical: 0 } as const;

export const server = new McpServer({
  name: 'claims-api',
  version: '1.0.0',
});

/**
 * Wire up the MCP tools against a Mongoose model retrieved from the NestJS DI
 * container.  Called once from `start()` after the application context is
 * bootstrapped.
 */
function registerTools(claimModel: Model<ClaimDocument>): void {
  server.tool(
    'lookup_claim',
    'Look up a claim by its claim id. Returns status, loss details, the triage recommendation if one has been produced, and the settlement if the claim has been paid. Health/medical data is never included.',
    { claimId: z.string().describe('The claim id, e.g. a UUID') },
    async ({ claimId }) => {
      // Exclude the PHI medical sub-document from the result (finding 3 & 5).
      const claim = await claimModel
        .findOne({ claimId }, NO_MEDICAL)
        .lean()
        .exec();

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
}

export async function start(): Promise<void> {
  // Bootstrap a NestJS application context (not a full HTTP server) so that
  // MongooseModule.forRoot() initialises the connection with the same URI,
  // TLS options and credentials that the HTTP process uses.  This replaces the
  // previous standalone mongoose.connect() call that used a separate,
  // potentially insecure connection (findings 1, 3, 4).
  const app = await NestFactory.createApplicationContext(AppModule, {
    // Suppress the NestJS HTTP-adapter banner — this process has no HTTP server.
    logger: ['error', 'warn'],
  });

  const claimModel = app.get<Model<ClaimDocument>>(
    getModelToken(Claim.name),
  );

  registerTools(claimModel);

  await server.connect(new StdioServerTransport());
}

if (require.main === module) {
  start().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('claims-api MCP server failed to start', error);
    process.exit(1);
  });
}
