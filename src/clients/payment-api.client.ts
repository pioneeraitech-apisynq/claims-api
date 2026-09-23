import axios from 'axios';

/**
 * Client for the internal Payment API.
 *
 * Claims never move money directly. When a claim is settled the payout is
 * booked through the Payment API, which owns the Stripe integration, and the
 * resulting payment is read back to confirm it cleared. The base URL comes from
 * PAYMENT_API_URL and the full path template is used at every call site so both
 * host and path are visible.
 *
 * The paths below mirror the Payment API's own openapi.yaml. That service
 * exposes a single money-movement primitive, `POST /v1/payments/charge`, which
 * the Claims API uses to book the settlement disbursement against the claim's
 * policy.
 */

export interface SettlementPayoutBody {
  policyId: string;
  customerId: string;
  amountCents: number;
  currency: string;
  paymentMethodId: string;
}

export interface PaymentResource {
  id: string;
  policyId: string;
  customerId: string;
  status: 'succeeded' | 'requires_action' | 'refunded';
  amountCents: number;
  currency: string;
  stripePaymentIntentId: string;
  createdAt: string;
}

function baseUrl(): string {
  return process.env.PAYMENT_API_URL || 'https://payment.digitalinsurance.dev';
}

/**
 * Book a claim settlement payout through the Payment API.
 * POST {PAYMENT_API_URL}/v1/payments/charge
 */
export async function createSettlementPayout(
  body: SettlementPayoutBody,
): Promise<PaymentResource> {
  const response = await axios.post(
    `${baseUrl()}/v1/payments/charge`,
    body,
    { timeout: 10000 },
  );
  return response.data as PaymentResource;
}

/**
 * Read back a settlement payment to confirm it cleared.
 * GET {PAYMENT_API_URL}/v1/payments/{paymentId}
 */
export async function getPayment(paymentId: string): Promise<PaymentResource> {
  const response = await axios.get(
    `${baseUrl()}/v1/payments/${paymentId}`,
    { timeout: 5000 },
  );
  return response.data as PaymentResource;
}
