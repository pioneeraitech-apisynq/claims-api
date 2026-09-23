# Claims API

The claims service of the Digital Insurance platform. Policyholders file claims
against it, upload the documents that back them, and get paid out through it. It
is a NestJS + TypeScript app.

This is a demo application.

## Dependencies

Two internal services, three infrastructure dependencies, and three AI
providers.

### Internal services

- **Policy API** — the Claims API does not own policies. It verifies the policy
  before a claim is accepted and reads the coverage limit before a payout is
  booked. Base URL from `POLICY_API_URL`; client in
  `src/clients/policy-api.client.ts`.
  - `GET /v1/policies/{policyNumber}`
  - `GET /v1/policies/{policyNumber}/quote-premium`
- **Payment API** — claims never move money directly. Settlement payouts are
  booked through the Payment API, which owns the Stripe integration. Base URL
  from `PAYMENT_API_URL`; client in `src/clients/payment-api.client.ts`.
  - `POST /v1/payments/charge`
  - `GET /v1/payments/{paymentId}`

### Infrastructure

- **MongoDB** (mongoose) — the claims collection. Schema in
  `src/claims/schemas/claim.schema.ts`.
- **Redis** (ioredis) — a lock so a claim is never triaged twice concurrently,
  and a 15-minute cache of triage results. `src/cache/redis.client.ts`.
- **AWS S3** (`@aws-sdk/client-s3`) — claim document bytes, stored under
  `claims/{claimId}/{documentId}/{filename}`. Only the object key goes to
  MongoDB. `src/storage/s3.client.ts`.

### AI

| What | Provider and model | Where |
|------|--------------------|-------|
| Claim triage agent | OpenAI `gpt-4o-mini` via the Vercel AI SDK, `generateObject` with a zod schema | `src/ai/agents/triage/triage.agent.ts`, prompt in `triage.prompt.ts` |
| Document extraction agent | Anthropic `claude-sonnet-4-5` via `@anthropic-ai/sdk` | `src/ai/agents/document/document.agent.ts`, prompt in `document.prompt.ts` |
| Policy wording retrieval (RAG) | OpenAI `text-embedding-3-small` embeddings + Pinecone | `src/ai/retrieval/` |
| MCP tools | `@modelcontextprotocol/sdk` over stdio | `src/mcp/claims-mcp.server.ts` |

The triage agent sees the claim narrative, the policyholder's details and, on
bodily-injury claims, the medical notes attached to the claim. Its prompt
constrains what it may do with that data: no inferred diagnosis, no risk
inference from personal characteristics, and no echoing the policyholder's date
of birth, email or address back into the output.

The MCP server exposes two read-only tools, `lookup_claim` and
`lookup_policy_coverage`, so an adjuster copilot running elsewhere can read the
same data the HTTP API serves. Run it with `npm run start:mcp`.

#### Routing AI traffic through the APISynQ gateway

The OpenAI client takes its base URL from `OPENAI_BASE_URL`
(`src/ai/openai.provider.ts`), defaulting to `https://api.openai.com/v1`. Set
that one variable to
`https://governance-api.apisynq.com/v1/ai-gw/openai/v1` and both the triage
completions and the embedding calls go through the APISynQ AI gateway with no
code change.

## Endpoints

| Method + path | What it does | Downstream call(s) it makes |
| ------------- | ------------ | --------------------------- |
| `POST /v1/claims` | File a claim | Policy API: `GET /v1/policies/{policyNumber}` |
| `GET /v1/claims?policyNumber=` | List claims, optionally per policy | MongoDB only |
| `GET /v1/claims/{claimId}` | Fetch a claim | MongoDB only |
| `POST /v1/claims/{claimId}/documents` | Upload a claim document | S3 put, then Anthropic `claude-sonnet-4-5` |
| `POST /v1/claims/{claimId}/triage` | Run triage | Redis lock + cache, Pinecone, Policy API (policy + coverage), OpenAI `gpt-4o-mini` |
| `POST /v1/claims/{claimId}/settle` | Pay the claimant | Policy API: `GET /v1/policies/{policyNumber}`; Payment API: `POST /v1/payments/charge` then `GET /v1/payments/{paymentId}` |
| `GET /health` | Liveness of the service, MongoDB and Redis | MongoDB, Redis |

The authoritative contract is in [`openapi.yaml`](./openapi.yaml); its paths
match the controller routes exactly.

## Configuration

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `PORT` | `3003` | Port the API listens on |
| `POLICY_API_URL` | `https://policy.digitalinsurance.dev` | Base URL of the internal Policy API |
| `PAYMENT_API_URL` | `https://payment.digitalinsurance.dev` | Base URL of the internal Payment API |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/claims` | Claims database |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Triage lock and result cache |
| `AWS_REGION` | `us-east-1` | Region of the claim documents bucket |
| `CLAIM_DOCUMENTS_BUCKET` | `digital-insurance-claim-docs` | S3 bucket for claim documents |
| `OPENAI_API_KEY` | — | Key for triage and embeddings |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Point at the APISynQ gateway to route OpenAI traffic through it |
| `ANTHROPIC_API_KEY` | — | Key for document extraction |
| `PINECONE_API_KEY` | — | Key for the policy wording index |
| `PINECONE_INDEX` | `policy-wording` | Pinecone index name |
| `PINECONE_NAMESPACE` | `policy-wording-v1` | Pinecone namespace |

Copy `.env.example` to `.env` and fill in real keys. The committed `.env` holds
placeholders only.

## Running

```bash
npm install
npm run build
npm start
```

The MCP server runs as its own process over stdio:

```bash
npm run start:mcp
```
