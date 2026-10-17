/**
 * A few chats with the organization's agent. A question sent through the
 * API is answered by a model, which the local stack has none of, so the
 * seed creates each chat through the API and writes its transcript into
 * the person's Workspace object, as core stores one: pi's messages, the
 * answers marked as no model's (as core marks its own,
 * `interruptedMessage` in apps/core/src/workspace.ts).
 */
import type { DatabaseSync } from "node:sqlite";

import type { PersonKey } from "./company.ts";

export interface ChatSeed {
  by: PersonKey;
  title: string;
  /** How long ago it started, in hours. */
  hoursAgo: number;
  /** Questions and answers, in turn. */
  turns: { question: string; answer: string }[];
}

export const chats: ChatSeed[] = [
  {
    by: "eva",
    title: "Invoices waiting longest",
    hoursAgo: 26,
    turns: [
      {
        question:
          "Which supplier invoices have waited longest for an approval?",
        answer:
          "Three invoices above €2,500 are waiting for finance to approve them in Supplier invoices. The oldest is from Kantoorhuis Utrecht (office rent), waiting since yesterday morning. You can answer each one from its run in Workflows.",
      },
      {
        question: "And how many failed this month?",
        answer:
          "Three runs of Supplier invoices failed in the last 30 days, each because the invoice had no VAT number. The coding rules in Finance say to send those back to the supplier.",
      },
    ],
  },
  {
    by: "lisa",
    title: "Complaint deadlines",
    hoursAgo: 50,
    turns: [
      {
        question: "How long do we have to acknowledge a complaint?",
        answer:
          "Two working days, in writing, according to the complaints procedure in Procedures. Complaints sets that deadline when it registers a complaint, and asks compliance before offering compensation above €250.",
      },
    ],
  },
  {
    by: "nina",
    title: "Files without a payslip",
    hoursAgo: 75,
    turns: [
      {
        question:
          "How many applications came in without a payslip in the last two weeks?",
        answer:
          "Of the applications Client onboarding checked in the last two weeks, about two in five still had documents to chase, most often the payslip or the employer statement. Required documents in Procedures says to chase them by email the same day.",
      },
      {
        question: "Draft a reminder I can send for a missing payslip.",
        answer:
          "Dear client,\n\nThank you for your application. To open your file we still need your most recent payslip, no older than three months. You can reply to this email with a photo or a PDF.\n\nKind regards,\nClient onboarding",
      },
    ],
  },
  {
    by: "sanne",
    title: "This week for the board",
    hoursAgo: 4,
    turns: [
      {
        question: "What should I tell the board about this week?",
        answer:
          "Runs held up well: most completed, a handful failed on bad input (empty emails, invoices without a VAT number, applications without an identity document), and a few wait on decisions, the oldest a file handover to mortgage advice. Compliance cleared every politically exposed client this month after enhanced due diligence.",
      },
    ],
  },
  {
    by: "mark",
    title: "Lender requirements",
    hoursAgo: 98,
    turns: [
      {
        question:
          "Which lender wants a valuation report no older than six months?",
        answer:
          "Lender A, according to Lender requirements in Client files. The page is past its review date, so it's worth checking with the lender before you rely on it.",
      },
    ],
  },
];

/** Core's own mark on an answer no model wrote: it names none, and cost nothing. */
const noModel = {
  api: "grasp",
  provider: "grasp",
  model: "grasp",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
} as const;

/** How long the agent takes to answer, in the transcript. */
const answerMs = 40_000;
/** How long the person takes to ask again. */
const nextQuestionMs = 6 * 60_000;

/**
 * Writes the chat's transcript into `db`, its person's Workspace object,
 * and moves the chat back to when it started.
 */
export const writeTranscript = (
  db: DatabaseSync,
  chatId: string,
  chat: ChatSeed,
  now: number
): void => {
  const start = now - chat.hoursAgo * 3_600_000;
  const insert = db.prepare(
    "INSERT INTO chat_messages (chat_id, message, created_at) VALUES (?, ?, ?)"
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE chats SET created_at = ? WHERE id = ?").run(
      start,
      chatId
    );
    for (const [index, { question, answer }] of chat.turns.entries()) {
      const asked = start + index * nextQuestionMs;
      const answered = asked + answerMs;
      insert.run(
        chatId,
        JSON.stringify({
          role: "user",
          content: [{ type: "text", text: question }],
          timestamp: asked,
        }),
        asked
      );
      insert.run(
        chatId,
        JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: answer }],
          ...noModel,
          timestamp: answered,
        }),
        answered
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};
