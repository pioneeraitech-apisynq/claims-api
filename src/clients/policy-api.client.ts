import axios from 'axios';

/**
 * Client for the internal Policy API.
 *
 * The Claims API does not own policies. Before a claim is accepted it verifies
 * that the quoted policy exists and is active, and before it settles it reads
 * the policy's coverage and current premium quote so the payout can be capped
 * at the coverage limit. The base URL comes from POLICY_API_URL and the full
 * path template is used at every call site so both host and path are visible.
 *
 * The paths below mirror the Policy API's own openapi.yaml. A claim carries a
 * `policyNumber`, which is the Policy API's `policyId`.
 */

export interface PolicyResource {
  id: string;
  customerId: string;
  productType: string;
  status: 'draft' | 'underwritten' | 'active' | 'cancelled' | 'declined';
  coverageAmountCents: number;
  termMonths: number;
  premiumCents: number;
  createdAt: string;
}

export interface PremiumQuoteResource {
  policyId: string;
  premiumCents: number;
  currency: string;
}

function baseUrl(): string {
  return process.env.POLICY_API_URL || 'https://policy.digitalinsurance.dev';
}

/**
 * Fetch the policy a claim is filed against.
 * GET {POLICY_API_URL}/v1/policies/{policyNumber}
 */
export async function getPolicy(policyNumber: string): Promise<PolicyResource> {
  const response = await axios.get(
    `${baseUrl()}/v1/policies/${policyNumber}`,
    { timeout: 5000 },
  );
  return response.data as PolicyResource;
}

/**
 * Read the coverage limit and current premium quote for a policy. The Policy
 * API exposes coverage through its locally computed premium quote endpoint.
 * GET {POLICY_API_URL}/v1/policies/{policyNumber}/quote-premium
 */
export async function getPolicyCoverage(
  policyNumber: string,
): Promise<PremiumQuoteResource> {
  const response = await axios.get(
    `${baseUrl()}/v1/policies/${policyNumber}/quote-premium`,
    { timeout: 5000 },
  );
  return response.data as PremiumQuoteResource;
}
