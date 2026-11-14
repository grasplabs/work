/**
 * The demo company's Knowledge: collections everyone reads, the
 * procedures and what the discovery heard, and one per team, each
 * written by the people who own it, with a second version where a
 * document was brought up to date. Some documents are past their
 * review date, so Knowledge has something to flag.
 */
import type { PersonKey, TeamName } from "./company.ts";
import {
  affordability,
  aiGuideline,
  approvalLimits,
  codingRules,
  complaintsProcedure,
  handoverChecklist,
  handoverChecklistUpdated,
  kycPolicy,
  lenderRequirements,
  monthEndClose,
  monthEndCloseUpdated,
  requiredDocuments,
  responseTimes,
} from "./documents.ts";
import type { CompanyDocument } from "./documents.ts";

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
const doc = ({ description, tags, review, body }: CompanyDocument): string =>
  [
    "---",
    `description: ${JSON.stringify(description)}`,
    `tags: [${tags.join(", ")}]`,
    ...(review === undefined ? [] : [`review: ${review}`]),
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");

/**
 * What the company told Grasp in the discovery's conversations, as the
 * prototype summarises them (`sources` in noordkade.ts): one document a
 * conversation, with who spoke and how.
 */
const conversations = [
  {
    path: "conversations/vision.md",
    title: "Vision conversation with the board",
    tag: "board",
    date: "2026-08-25",
    who: "CEO, COO and CFO",
    how: "Recorded, 82 minutes",
    paragraphs: [
      "The board wants every client to get a clear answer within a working day, and wants advisors to spend their time on advice rather than paperwork. Client numbers grew by a third in a year without new hires, and the backlog in customer service now shows in client reviews.",
      "Their worries are concrete: client data ending up in public AI tools, advisors losing trust when AI gets a file wrong, and another pilot that stops after the pilot. Some people already use AI tools on their own; Copilot is licensed for customer service only.",
      "The COO approves a new tool after a check by IT, and anything that costs money goes past the CFO. The monthly budget for AI stays open until the CFO has looked at it. Which data and tools are allowed is left to the draft guideline, for compliance and IT to own. The COO is the main contact, and the five teams to interview were agreed with a stakeholder each.",
    ],
  },
  {
    path: "conversations/client-onboarding.md",
    title: "Interview with the client onboarding team",
    tag: "onboarding",
    date: "2026-08-27",
    who: "Head of client onboarding",
    how: "Live, 45 minutes",
    paragraphs: [
      "Client onboarding turns an application into a complete client file. The team wants every new client to have a complete file on the first day, and today that rarely happens.",
      "Half of all applications arrive without a payslip or ID, and the team chases each one by email in Outlook. Checking ID and income documents takes more time than anything else they do, and client data that is already in the application is typed into the CRM again. Which documents are still missing is tracked per application in Airtable.",
      "When a file is complete it goes to mortgage advice. The head of onboarding knows that advisors still ask clients for documents again, and sees it as a problem between the two teams rather than inside either one.",
    ],
  },
  {
    path: "conversations/mortgage-advice.md",
    title: "Interview with the mortgage advice team",
    tag: "advice",
    date: "2026-08-27",
    who: "Team lead mortgage advice",
    how: "Voice agent, 38 minutes",
    paragraphs: [
      "Mortgage advice says getting a file complete takes longer than the advice itself. Files from onboarding often miss documents a lender needs, so advisors go back to the client, through the client portal or by phone.",
      "Every lender portal wants the same data in a different format. Which lenders take most files, and whether any of them offer an API, is something the team lead wants to check before we draw anything.",
      "Client meetings run on Zoom, and advisors type up their notes afterwards. Procedures live in Notion, but half the team still works from old Word copies.",
      "What would help most: a draft affordability calculation ready when an advisor opens a file. Today that calculation lives in an Excel sheet each advisor keeps up to date themselves.",
    ],
  },
  {
    path: "conversations/customer-service.md",
    title: "Interview with customer service",
    tag: "service",
    date: "2026-08-28",
    who: "Head of customer service",
    how: "Chat link",
    paragraphs: [
      "About 600 emails a week land in one shared inbox, and every one is routed by hand. Most questions are about the status of a file, which the team looks up in the CRM before answering.",
      "Complex questions go to an advisor by forwarding the email, and answers get lost on the way back. The team drafts replies with Copilot, but Copilot cannot see the CRM, so every draft is checked against it by hand. Website chats come in through Intercom and are answered apart from the email.",
    ],
  },
  {
    path: "conversations/finance.md",
    title: "Interview with finance, including hourly cost",
    tag: "finance",
    date: "2026-08-28",
    who: "Controller",
    how: "Live, 45 minutes",
    paragraphs: [
      "The weekly management report takes the controller most of Monday. Figures come from five systems, Exact, the CRM and several Excel sheets among them, and they never quite match. Finance wants the board to have the numbers before the Monday meeting.",
      "Supplier invoices are coded by hand in Exact, and approvals are chased by email. The controller gave an average hourly cost of 55 euros for the whole company, as an estimate, to value the hours we find.",
    ],
  },
  {
    path: "conversations/compliance.md",
    title: "Interview with compliance",
    tag: "compliance",
    date: "2026-09-01",
    who: "Head of compliance",
    how: "Voice agent, 31 minutes",
    paragraphs: [
      "Complaints are registered by hand in an Excel sheet. Customer service forwards them by email, sometimes days late, while the complaints procedure promises an acknowledgement within two working days.",
      "One rule is firm: client data may not leave Microsoft 365. How many complaints come in each week is not known yet; the head of compliance will count them.",
    ],
  },
] as const;

const conversationDocuments: DocumentSeed[] = conversations.map(
  ({ path, title, tag, date, who, how, paragraphs }) => ({
    path,
    text: doc({
      description: `${title}: ${who}, ${date}.`,
      tags: ["discovery", tag],
      body: [`# ${title}`, `${who}. ${how}, ${date}.`, ...paragraphs].join(
        "\n\n"
      ),
    }),
  })
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
      {
        path: "onboarding/required-documents.md",
        text: doc(requiredDocuments),
      },
      { path: "service/response-times.md", text: doc(responseTimes) },
      { path: "service/complaints.md", text: doc(complaintsProcedure) },
      { path: "advice/affordability.md", text: doc(affordability) },
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
        text: doc(monthEndClose),
        update: {
          text: doc(monthEndCloseUpdated),
          message: "Jeroen reconciles the commissions from now on",
        },
      },
      { path: "invoices/coding.md", text: doc(codingRules) },
      { path: "invoices/approval-limits.md", text: doc(approvalLimits) },
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
      { path: "lenders.md", text: doc(lenderRequirements) },
      {
        path: "handover.md",
        text: doc(handoverChecklist),
        update: {
          text: doc(handoverChecklistUpdated),
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
      { path: "kyc.md", text: doc(kycPolicy) },
      { path: "ai-and-data.md", text: doc(aiGuideline) },
    ],
  },
  {
    name: "Discovery",
    description:
      "What the board and the teams told Grasp in the discovery: the vision conversation and an interview with each team.",
    createdBy: "sanne",
    writer: "sanne",
    teams: [],
    documents: conversationDocuments,
  },
];
