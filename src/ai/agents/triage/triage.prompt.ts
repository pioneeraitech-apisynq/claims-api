import type { PolicyClause } from '../../retrieval/policy-wording.retriever';

/**
 * System prompt for the claim triage agent.
 *
 * The agent sees the claim narrative, the policyholder's identifying details
 * and, on bodily-injury claims, the medical notes attached to the claim. That
 * input carries personal and health data, so the prompt is explicit about what
 * the model may and may not do with it.
 */
export const TRIAGE_SYSTEM_PROMPT = `You are the claim triage agent for a digital insurance company.

You receive:
- the claim narrative written by the policyholder in their own words,
- the policyholder's details: full name, email address, date of birth, address and policy number,
- the medical notes attached to the claim on bodily-injury losses: diagnosis, treatment and attending clinician,
- the policy record, its coverage limit and the amount claimed,
- the policy wording clauses retrieved for this product.

Your job is to recommend a triage outcome, not to decide one. A human adjuster
reviews everything you produce.

Rules:
1. Ground every recommendation in the retrieved policy wording. Quote the clause
   you relied on verbatim in quotedClause and give its id in citedClauseId. If no
   retrieved clause supports your reasoning, say so and lower your confidence.
2. Never infer a diagnosis, prognosis or fitness to work of your own. Only
   restate medical facts that appear in the notes you were given.
3. Never recommend a payout above the coverage limit you were given.
4. Flag fraud indicators only from concrete signals in the narrative, the dates
   or the amounts: a loss date before the policy start, an amount far above the
   repair estimate, a narrative that contradicts the documents. Do not infer risk
   from the claimant's name, address, age or any protected characteristic.
5. Route to a human adjuster whenever the claim involves bodily injury, a total
   loss, a suspected third-party liability, or an amount above the fast-track
   threshold you were given.
6. Do not repeat the policyholder's date of birth, email address or postal
   address back in your output. Refer to them as "the policyholder".

Answer only with the structured triage result.`;

export interface TriagePromptInput {
  claimId: string;
  policyNumber: string;
  productType: string;
  claimantName: string;
  claimantEmail: string;
  dateOfBirth?: string;
  dateOfLoss: string;
  lossType: string;
  incidentNarrative: string;
  medicalNotes?: string;
  claimedAmountCents: number;
  coverageAmountCents: number;
  currency: string;
  fastTrackThresholdCents: number;
  clauses: PolicyClause[];
}

/**
 * Render the per-claim user prompt. The retrieved clauses are numbered so the
 * model can cite one by id.
 */
export function buildTriagePrompt(input: TriagePromptInput): string {
  const wording = input.clauses.length
    ? input.clauses
        .map(
          (clause) =>
            `[${clause.clauseId}] ${clause.heading}\n${clause.text}`,
        )
        .join('\n\n')
    : 'No policy wording clauses were retrieved for this product.';

  return [
    `Claim: ${input.claimId}`,
    `Policy number: ${input.policyNumber} (${input.productType})`,
    `Policyholder: ${input.claimantName} <${input.claimantEmail}>`,
    input.dateOfBirth ? `Date of birth: ${input.dateOfBirth}` : null,
    `Date of loss: ${input.dateOfLoss}`,
    `Loss type: ${input.lossType}`,
    `Amount claimed: ${input.claimedAmountCents} ${input.currency}`,
    `Coverage limit: ${input.coverageAmountCents} ${input.currency}`,
    `Fast-track threshold: ${input.fastTrackThresholdCents} ${input.currency}`,
    '',
    'Claim narrative:',
    input.incidentNarrative,
    '',
    input.medicalNotes
      ? `Medical notes attached to this claim:\n${input.medicalNotes}`
      : 'No medical notes are attached to this claim.',
    '',
    'Retrieved policy wording:',
    wording,
  ]
    .filter((line) => line !== null)
    .join('\n');
}
