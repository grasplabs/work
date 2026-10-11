/**
 * The demo company's Knowledge: a collection everyone reads, and one per
 * team, each written by the people who own it, with a second version
 * where a document was brought up to date. Some documents are past their
 * review date, so Knowledge has something to flag.
 */
import type { PersonKey, TeamName } from "./company.ts";

export interface DocumentSeed {
  path: string;
  text: string;
  /** A later version, with what changed. */
  update?: { text: string; message: string };
}

export interface CollectionSeed {
  name: string;
  description: string;
  /** The admin who creates it: only admins create shared collections. */
  createdBy: PersonKey;
  /** Who writes its documents: someone it is shared with. */
  writer: PersonKey;
  /** Everyone, or only these teams. */
  teams: TeamName[];
  sensitive?: boolean;
  documents: DocumentSeed[];
}

/** A document: its frontmatter, then its Markdown. */
const doc = (
  meta: { description: string; tags: string[]; review?: string },
  body: string
): string =>
  [
    "---",
    `description: ${JSON.stringify(meta.description)}`,
    `tags: [${meta.tags.join(", ")}]`,
    ...(meta.review === undefined ? [] : [`review: ${meta.review}`]),
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");

const requiredDocuments = doc(
  {
    description:
      "What every mortgage application needs before it becomes a client file.",
    tags: ["onboarding", "documents"],
    review: "2027-03-01",
  },
  `
# Required documents

Every application needs these four before onboarding opens a client file:

1. **Identity**: a valid passport or identity card of each applicant.
2. **Payslip**: the most recent one, no older than three months.
3. **Employer statement**: signed, no older than three months.
4. **Bank statements**: the last three months, showing salary payments.

Self-employed applicants send the last three annual accounts instead of a payslip and an employer statement.

Missing documents are chased by email the same day. After three reminders without an answer, the application is put on hold and the client is called.
`
);

const responseTimes = doc(
  {
    description: "How quickly customer service answers, by channel.",
    tags: ["service"],
    review: "2026-09-15",
  },
  `
# Response times

| Channel | First answer within |
| --- | --- |
| Email | 1 working day |
| Phone | 2 minutes on average |
| Web form | 1 working day |
| Complaint | Acknowledged within 2 working days |

A question about the status of a file is answered from the CRM, never from memory. A question an adviser must answer goes to the adviser through the service desk, so the answer comes back the same way.
`
);

const complaintsProcedure = doc(
  {
    description:
      "How a complaint is registered, acknowledged and resolved, and when compliance approves compensation.",
    tags: ["complaints", "service", "compliance"],
    review: "2027-01-15",
  },
  `
# Complaints procedure

1. Register every complaint the day it comes in, whatever the channel.
2. Acknowledge it within **two working days**, in writing.
3. Resolve it within **six weeks**, or tell the client why it takes longer.
4. Compensation up to **€250** is offered by customer service. Above that, compliance approves it first.

Every complaint is reported to the board each quarter, by kind and by how long it took.
`
);

const affordability = doc(
  {
    description:
      "How advisers draft the affordability calculation before the first meeting.",
    tags: ["advice", "mortgage"],
  },
  `
# Affordability calculation

Advisers draft the calculation before the first meeting, from what the client file holds:

- gross annual income, from the employer statement;
- existing debts, from the bank statements and the BKR check;
- the energy label of the home, which raises the maximum loan.

The calculation follows the Nibud tables of the current year. A draft is never shared with the client before an adviser has checked it.
`
);

const monthEndClose = doc(
  {
    description: "The month-end close, day by day, and who does what.",
    tags: ["finance", "close"],
    review: "2026-12-01",
  },
  `
# Month-end close

| Day | What | Who |
| --- | --- | --- |
| 1 | Bank reconciled | Eva |
| 2 | Accruals booked | Eva |
| 3 | VAT return checked | Jeroen |
| 4 | Commissions reconciled with the lenders' statements | Eva |
| 5 | Board report sent | Sanne |

The target is to close in five working days.
`
);

const monthEndCloseUpdated = monthEndClose.replace(
  "| 4 | Commissions reconciled with the lenders' statements | Eva |",
  "| 4 | Commissions reconciled with the lenders' statements | Jeroen |"
);

const codingRules = doc(
  {
    description:
      "Which ledger account each kind of supplier invoice is booked on.",
    tags: ["finance", "invoices"],
  },
  `
# Coding supplier invoices

| Kind of cost | Account |
| --- | --- |
| Rent, energy, cleaning | 4100 Housing |
| Software, data, laptops, phones | 4300 Software and data |
| Brochures, events | 4500 Marketing |
| Legal and other advice | 4700 Advice |
| Anything else | 4900 Other costs |

An invoice without a VAT number is sent back to the supplier, never booked.
`
);

const approvalLimits = doc(
  {
    description: "Who approves what, and up to which amount.",
    tags: ["finance", "approvals"],
  },
  `
# Approval limits

- Supplier invoices up to **€2,500** are booked once coded.
- Above €2,500, someone in finance approves the invoice.
- Above €25,000, the CFO approves it too.
- New software is approved by the COO after a check by IT.
`
);

const lenderRequirements = doc(
  {
    description:
      "What the lenders we work with most ask for, beyond the standard documents.",
    tags: ["advice", "lenders"],
    review: "2026-08-31",
  },
  `
# Lender requirements

Most files go to four lenders. What each asks for beyond the standard documents:

- **Lender A**: a valuation report no older than six months.
- **Lender B**: the energy label, for the sustainability discount.
- **Lender C**: two years of annual accounts for self-employed clients.
- **Lender D**: a signed declaration of existing debts.
`
);

const handoverChecklist = doc(
  {
    description: "What a file holds before onboarding hands it to an adviser.",
    tags: ["onboarding", "advice"],
  },
  `
# Handing a file over

A file goes to mortgage advice once:

- all four required documents are in it and checked;
- the client's details are in the CRM, typed once;
- the know-your-customer check has cleared the client;
- the client knows which adviser will call them.

The adviser takes the file over in Grasp. A file nobody takes over within five working days goes back to onboarding.
`
);

const handoverChecklistUpdated = handoverChecklist.replace(
  "- the client knows which adviser will call them.",
  "- the client knows which adviser will call them, and when."
);

const kycPolicy = doc(
  {
    description:
      "How new clients are screened, and when enhanced due diligence applies.",
    tags: ["compliance", "kyc"],
    review: "2027-06-30",
  },
  `
# Know your customer

Every new client is screened before advice starts.

| Risk | When | What follows |
| --- | --- | --- |
| Low | Resident in the Netherlands | Cleared at once |
| Medium | Resident elsewhere | Cleared at once, reviewed yearly |
| High | Politically exposed person | Enhanced due diligence, cleared by a compliance officer |

A client without a valid identity document is never screened: the file waits for one.
`
);

const aiGuideline = doc(
  {
    description:
      "Which data and tools may be used with AI, as compliance and IT agreed.",
    tags: ["compliance", "ai", "data"],
  },
  `
# AI and data guideline

- Client data stays in the EU, in tools the company has approved.
- No client data goes into public AI tools.
- Every automated step that changes a client file is logged, with who approved it.
- A person approves anything that leaves the company: an offer, a compensation, a letter to a lender.
`
);

export const collections: CollectionSeed[] = [
  {
    name: "Procedures",
    description:
      "How the company works: onboarding, advice, service and complaints. Start here for any question about a procedure.",
    createdBy: "sanne",
    writer: "sanne",
    teams: [],
    documents: [
      { path: "onboarding/required-documents.md", text: requiredDocuments },
      { path: "service/response-times.md", text: responseTimes },
      { path: "service/complaints.md", text: complaintsProcedure },
      { path: "advice/affordability.md", text: affordability },
    ],
  },
  {
    name: "Finance",
    description:
      "Finance's handbook: the month-end close, coding invoices and approval limits.",
    createdBy: "sanne",
    writer: "eva",
    teams: ["Finance"],
    documents: [
      {
        path: "month-end-close.md",
        text: monthEndClose,
        update: {
          text: monthEndCloseUpdated,
          message: "Jeroen reconciles the commissions from now on",
        },
      },
      { path: "invoices/coding.md", text: codingRules },
      { path: "invoices/approval-limits.md", text: approvalLimits },
    ],
  },
  {
    name: "Client files",
    description:
      "What onboarding and mortgage advice agreed about client files: lenders' requirements and the handover.",
    createdBy: "sanne",
    writer: "nina",
    teams: ["Client onboarding", "Mortgage advice"],
    documents: [
      { path: "lenders.md", text: lenderRequirements },
      {
        path: "handover.md",
        text: handoverChecklist,
        update: {
          text: handoverChecklistUpdated,
          message: "Tell the client when the adviser calls",
        },
      },
    ],
  },
  {
    name: "Compliance",
    description:
      "Compliance policies: know your customer, and the AI and data guideline.",
    createdBy: "pieter",
    writer: "joost",
    teams: ["Compliance"],
    sensitive: true,
    documents: [
      { path: "kyc.md", text: kycPolicy },
      { path: "ai-and-data.md", text: aiGuideline },
    ],
  },
];
