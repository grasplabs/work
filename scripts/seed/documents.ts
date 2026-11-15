/**
 * The demo company's own documents: its procedures, finance's handbook,
 * what onboarding and advice agreed about client files, and compliance's
 * policies, each as its Markdown, opening with its title as a heading.
 * People upload them into the Brain as Word files (scripts/seed/brain.ts).
 */

export const requiredDocuments = `
# Required documents

Every application needs these four before onboarding opens a client file:

1. **Identity**: a valid passport or identity card of each applicant.
2. **Payslip**: the most recent one, no older than three months.
3. **Employer statement**: signed, no older than three months.
4. **Bank statements**: the last three months, showing salary payments.

Self-employed applicants send the last three annual accounts instead of a payslip and an employer statement.

Missing documents are chased by email the same day. After three reminders without an answer, the application is put on hold and the client is called.
`;

export const responseTimes = `
# Response times

| Channel | First answer within |
| --- | --- |
| Email | 1 working day |
| Phone | 2 minutes on average |
| Web form | 1 working day |
| Complaint | Acknowledged within 2 working days |

A question about the status of a file is answered from the CRM, never from memory. A question an adviser must answer goes to the adviser through the service desk, so the answer comes back the same way.
`;

export const complaintsProcedure = `
# Complaints procedure

1. Register every complaint the day it comes in, whatever the channel.
2. Acknowledge it within **two working days**, in writing.
3. Resolve it within **six weeks**, or tell the client why it takes longer.
4. Compensation up to **€250** is offered by customer service. Above that, compliance approves it first.

Every complaint is reported to the board each quarter, by kind and by how long it took.
`;

export const affordability = `
# Affordability calculation

Advisers draft the calculation before the first meeting, from what the client file holds:

- gross annual income, from the employer statement;
- existing debts, from the bank statements and the BKR check;
- the energy label of the home, which raises the maximum loan.

The calculation follows the Nibud tables of the current year. A draft is never shared with the client before an adviser has checked it.
`;

export const monthEndClose = `
# Month-end close

| Day | What | Who |
| --- | --- | --- |
| 1 | Bank reconciled | Eva |
| 2 | Accruals booked | Eva |
| 3 | VAT return checked | Jeroen |
| 4 | Commissions reconciled with the lenders' statements | Eva |
| 5 | Board report sent | Sanne |

The target is to close in five working days.
`;

export const codingRules = `
# Coding supplier invoices

| Kind of cost | Account |
| --- | --- |
| Rent, energy, cleaning | 4100 Housing |
| Software, data, laptops, phones | 4300 Software and data |
| Brochures, events | 4500 Marketing |
| Legal and other advice | 4700 Advice |
| Anything else | 4900 Other costs |

An invoice without a VAT number is sent back to the supplier, never booked.
`;

export const approvalLimits = `
# Approval limits

- Supplier invoices up to **€2,500** are booked once coded.
- Above €2,500, someone in finance approves the invoice.
- Above €25,000, the CFO approves it too.
- New software is approved by the COO after a check by IT.
`;

export const lenderRequirements = `
# Lender requirements

Most files go to four lenders. What each asks for beyond the standard documents:

- **Lender A**: a valuation report no older than six months.
- **Lender B**: the energy label, for the sustainability discount.
- **Lender C**: two years of annual accounts for self-employed clients.
- **Lender D**: a signed declaration of existing debts.
`;

export const handoverChecklist = `
# Handing a file over

A file goes to mortgage advice once:

- all four required documents are in it and checked;
- the client's details are in the CRM, typed once;
- the know-your-customer check has cleared the client;
- the client knows which adviser will call them.

The adviser takes the file over in Grasp. A file nobody takes over within five working days goes back to onboarding.
`;

export const kycPolicy = `
# Know your customer

Every new client is screened before advice starts.

| Risk | When | What follows |
| --- | --- | --- |
| Low | Resident in the Netherlands | Cleared at once |
| Medium | Resident elsewhere | Cleared at once, reviewed yearly |
| High | Politically exposed person | Enhanced due diligence, cleared by a compliance officer |

A client without a valid identity document is never screened: the file waits for one.
`;

export const aiGuideline = `
# AI and data guideline

- Client data stays in the EU, in tools the company has approved.
- No client data goes into public AI tools.
- Every automated step that changes a client file is logged, with who approved it.
- A person approves anything that leaves the company: an offer, a compensation, a letter to a lender.
`;

/** The close, once Jeroen took over the commissions from Eva. */
export const monthEndCloseUpdated = monthEndClose.replace(
  "| 4 | Commissions reconciled with the lenders' statements | Eva |",
  "| 4 | Commissions reconciled with the lenders' statements | Jeroen |"
);

/** The handover, once the client is told when the adviser calls. */
export const handoverChecklistUpdated = handoverChecklist.replace(
  "- the client knows which adviser will call them.",
  "- the client knows which adviser will call them, and when."
);
