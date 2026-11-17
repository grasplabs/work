import {
  brainOf,
  packItemTokens,
  recallBudgetMax,
  vectorModelNameOf,
} from "@grasp-os/brain-next/contract";
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  affordability,
  aiGuideline,
  approvalLimits,
  codingRules,
  complaintsProcedure,
  handoverChecklist,
  kycPolicy,
  lenderRequirements,
  monthEndClose,
  requiredDocuments,
  responseTimes,
} from "../../../scripts/seed/documents.ts";
import { chatTurnSource } from "../src/brain-next-origins.ts";
import {
  addSource,
  recallAs,
  recallOwnedAs,
  rememberAs,
} from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { embedderModel, questionVectorOf } from "../src/embedder.ts";
import { turnRecallBudget } from "../src/turn-recall.ts";
import { recalledByMeaning } from "./brain-next-leaks-harness.ts";
import { outWord } from "./brain-next-out-reads.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi, unique } from "./sign-in.ts";

// How often a chat's first turn is marked as having used what only its
// person may read (GRA-1944, brain-next.ts `recallOwnedAs`), on a fixed
// company and a person with ordinary content of their own: the demo's
// company documents, everyone's; three uploads, six earlier chat turns
// and three memories of the person's own; and varied questions, each
// recalled as a chat's first turn recalls it. The rule is the property:
// a question is marked exactly when what the recall hands over differs
// from what the shared store alone hands over (a recall as their teams,
// which reads no own store). The rate itself is reported, not asserted:
// it moves with the store and with recall by meaning.

const idp = mockIdp();

/** Adding the company and the person's content takes a while on CI. */
const slow = { timeout: 120_000 };

const companyDocuments = [
  requiredDocuments,
  responseTimes,
  complaintsProcedure,
  affordability,
  monthEndClose,
  codingRules,
  approvalLimits,
  lenderRequirements,
  handoverChecklist,
  kycPolicy,
  aiGuideline,
];

const ownUploads = [
  `# Board meeting notes

- Customer service answers most emails within a working day again; the complaints backlog is down to four.
- Ask the CFO for the AI budget before the next meeting.
- Advisers want the affordability draft ready when they open a file: put it on the roadmap for next quarter.`,
  `# My close notes

- Lender B's commission statement comes a day late: start the reconciliation with the others and add it on day 4.
- Jeroen takes over the commissions from this month; walk him through the lenders' statements first.
- The VAT return goes to Jeroen on day 3, not before the accruals are booked.`,
  `# Client calls this week

- Tuesday: the Bos family, refinancing. They still owe the energy label for Lender B's discount.
- Wednesday: a self-employed client, first meeting. Ask for two years of annual accounts for Lender C.
- Friday: follow up on the valuation report that expired last month.`,
];

const earlierTurns = [
  "Me: Which documents does the Bos family still owe?\nGrasp: The energy label, for Lender B's discount.",
  "Me: Draft a reply to the complaint about the late valuation.\nGrasp: Here is a draft that apologises and names the new date.",
  "Me: When is the VAT return due this quarter?\nGrasp: On day 3 of the close, after the accruals are booked.",
  "Me: Summarise what the board said about the AI budget.\nGrasp: Ask the CFO before the next meeting.",
  "Me: What does Lender C ask of a self-employed client?\nGrasp: Two years of annual accounts.",
  "Me: Remind me to walk Jeroen through the commissions.\nGrasp: Noted for this month's close.",
];

const ownMemories = [
  {
    names: ["Bos family"],
    statement: "The Bos family is refinancing with Lender B",
  },
  {
    names: ["Jeroen"],
    statement: "Jeroen takes over the commissions this month",
  },
  {
    names: ["Lender B"],
    statement: "Lender B's commission statement comes a day late",
  },
];

const questions = [
  "Hi",
  "Thanks!",
  "Translate 'goedemorgen' into English.",
  "Which documents does an application need?",
  "How fast do we answer an email?",
  "What is the complaints procedure?",
  "How much compensation can customer service offer?",
  "How is the affordability calculation drafted?",
  "What happens at month-end close?",
  "How do I code a supplier invoice?",
  "Who approves an invoice above the limit?",
  "What does Lender B require?",
  "How do I hand a client file over?",
  "What does our KYC policy say about identity checks?",
  "May I paste client data into an AI tool?",
  "What do I still owe the Bos family?",
  "When is the VAT return due?",
  "Who takes over the commissions?",
  "What did the board say about the AI budget?",
  "What should I ask a self-employed client for?",
  "Draft an email chasing a missing payslip.",
  "Summarise the response times per channel.",
  "Is the energy label part of the calculation?",
  "Which bank statements do we need?",
  "What do I do after three reminders?",
  "How long may a complaint take to resolve?",
  "Write a short note for the team about the close.",
  "What is on my calls list this week?",
];

/** Adds `text` as a source of `source`'s, read by `readers`. */
const added = async (
  source: SourceRef,
  text: string,
  readers: SourceReaders
): Promise<void> => {
  await addSource(env, {
    source,
    change: crypto.randomUUID(),
    text,
    readers,
  });
};

/** Adds a copy of each company document, everyone's. */
const addCompany = async (): Promise<void> => {
  for (const text of companyDocuments) {
    // oxlint-disable-next-line no-await-in-loop -- added one after another
    await added({ producer: "upload", id: crypto.randomUUID() }, text, {
      kind: "everyone",
    });
  }
};

/**
 * Each question recalled by `personId` as a chat's first turn recalls it:
 * whether it marks the chat, and whether what it hands over differs from
 * what a recall as their teams, which reads no own store, hands over.
 */
const recalledBy = async (personId: string) => {
  const recalled = [];
  for (const question of questions) {
    // oxlint-disable-next-line no-await-in-loop -- one recall at a time, as a chat's
    const own = await recallOwnedAs(env, personId, {
      question,
      budget: turnRecallBudget,
      personal: true,
    });
    // oxlint-disable-next-line no-await-in-loop -- one recall at a time, as a chat's
    const shared = await recallAs(env, personId, {
      question,
      budget: turnRecallBudget,
      personal: false,
    });
    recalled.push({
      question,
      marked: own.fromOwn,
      differs: JSON.stringify(own.pack) !== JSON.stringify(shared),
    });
  }
  return recalled;
};

describe("how often a chat's first turn is marked", () => {
  it(
    "marks a question exactly when the person's own store changes what the recall hands over, at two sizes of the company's store, and reports how often",
    slow,
    async ({ annotate }) => {
      const person = await signedInApi(idp, "user");
      const personId = person.userId;
      const owner: SourceReaders = { kind: "owner", personId };
      for (const text of ownUploads) {
        // oxlint-disable-next-line no-await-in-loop -- added one after another
        await added(
          { producer: "upload", id: crypto.randomUUID() },
          text,
          owner
        );
      }
      const chatId = crypto.randomUUID();
      for (const [at, text] of earlierTurns.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- added one after another
        await added(chatTurnSource(personId, chatId, at + 1), text, owner);
      }
      for (const { names, statement } of ownMemories) {
        // oxlint-disable-next-line no-await-in-loop -- added one after another
        await rememberAs(env, personId, {
          change: crypto.randomUUID(),
          about: { kind: "customer", names },
          type: "fact",
          statement,
          quote: statement,
        });
      }
      const sizes = [];
      // The company's documents once, then twice: more of the company's
      // passages then fill what a way lists ahead of the person's own.
      for (const copies of [1, 2]) {
        // oxlint-disable-next-line no-await-in-loop -- one size after the other
        await addCompany();
        // oxlint-disable-next-line no-await-in-loop -- one size after the other
        const recalled = await recalledBy(personId);
        const marked = recalled.filter((each) => each.marked).length;
        // oxlint-disable-next-line no-await-in-loop -- one size after the other
        await annotate(
          `Marked ${marked} of ${questions.length} first turns (${companyDocuments.length * copies} company documents)`
        );
        sizes.push(recalled);
      }

      expect(
        sizes.map((recalled) => ({
          // Both kinds are among the questions: the rule is held both ways.
          both: new Set(recalled.map((each) => each.marked)).size,
          marks: recalled.map(({ question, marked }) => ({ question, marked })),
        }))
      ).toStrictEqual(
        sizes.map((recalled) => ({
          both: 2,
          marks: recalled.map(({ question, differs }) => ({
            question,
            marked: differs,
          })),
        }))
      );
    }
  );
});

/** Most alarms a person's own store may take to embed its passages. */
const ownAlarmsMost = 50;

/**
 * Runs `personId`'s own store's alarms until it sleeps with every passage
 * embedded by the model core runs, as it does on its own once something
 * is added; fails if it doesn't within `ownAlarmsMost` alarms.
 */
const ownEmbedded = async (personId: string): Promise<void> => {
  const own = inJurisdiction(env, env.BRAIN_STORE).getByName(
    `person:${personId}`
  );
  let awake = true;
  for (let run = 0; awake && run < ownAlarmsMost; run += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one alarm after another
    awake = await runDurableObjectAlarm(own);
  }
  const { embedding } = await own.workOverview();
  if (
    awake ||
    !embedding.rebuilt ||
    embedding.embedded + embedding.unembeddable !== embedding.chunks
  ) {
    throw new Error(
      `The own store wasn't embedded in ${ownAlarmsMost} alarms: ${JSON.stringify(embedding)}`
    );
  }
};

/** `personId`'s first-turn recall of `question` within `tokens`, by meaning. */
const ownedByMeaning = async (
  personId: string,
  question: string,
  tokens: number
) => {
  const { value } = await recalledByMeaning(
    "a first turn's recall",
    async () =>
      await recallOwnedAs(env, personId, {
        question,
        budget: { tokens },
        personal: true,
      })
  );
  return value;
};

/** The vector core's question embedder gives `question`, asked until it answers in time. */
const questionVector = async (question: string): Promise<number[]> => {
  for (let ask = 0; ask < 5; ask += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one ask after another
    const embedded = await questionVectorOf(env, question);
    if (embedded.kind === "vector") {
      return embedded.vector;
    }
  }
  throw new Error("The question embedder never answered in time");
};

describe("a chat's first turn, by meaning", () => {
  it(
    "marks a turn whose recall finds a passage of the person's own by meaning alone, its words only in the company's",
    slow,
    async () => {
      const person = await signedInApi(idp, "user");
      const personId = person.userId;
      const own: SourceRef = { producer: "upload", id: crypto.randomUUID() };
      await added(own, "Kerstrooster voor de winkel in december.", {
        kind: "owner",
        personId,
      });
      await ownEmbedded(personId);
      const word = `w${unique().replaceAll(/\W/gu, "")}`;
      await added(
        { producer: "upload", id: crypto.randomUUID() },
        `The ${word} policy covers travel.`,
        { kind: "everyone" }
      );

      const { pack, fromOwn } = await ownedByMeaning(
        personId,
        `${word} policy`,
        recallBudgetMax
      );

      expect({
        own: pack.items
          .filter(({ source }) => source.id === own.id)
          .map(({ found }) => found),
        fromOwn,
      }).toStrictEqual({ own: ["meaning"], fromOwn: true });
    }
  );

  it(
    "marks a turn whose recall the person's own store only reorders: its passage takes a rank by meaning, the budget leaves it out, and the company's passages come in another order",
    slow,
    async () => {
      const person = await signedInApi(idp, "user");
      const personId = person.userId;
      // Letters alone: a word with a digit would be an ID, found exactly too.
      const word = outWord("w");
      const question = `${word} rota`;
      // The person's own passage, by meaning alone (it holds no word of
      // the question), its citation too long for what the budget leaves.
      const own: SourceRef = { producer: "upload", id: "o".repeat(240) };
      await added(own, "Kerstrooster voor de winkel in december.", {
        kind: "owner",
        personId,
      });
      await ownEmbedded(personId);
      // The company's: two by the question's words, the first holding
      // both; one by meaning alone; and one by a word, ranked last, whose
      // citation never fits, so both packs are cut short alike.
      const company = {
        first: `${word} rota for the depot.`,
        second: `${word} notes.`,
        meant: "Opening hours of the shop.",
        last: `${word} archive of every older note kept for the record.`,
      };
      const ids = {
        first: crypto.randomUUID(),
        second: crypto.randomUUID(),
        meant: crypto.randomUUID(),
        last: "l".repeat(240),
      };
      for (const key of ["first", "second", "meant", "last"] as const) {
        // oxlint-disable-next-line no-await-in-loop -- added one after another
        await added({ producer: "upload", id: ids[key] }, company[key], {
          kind: "everyone",
        });
      }
      // The company's passage by meaning has the one code the shared store
      // holds: the farthest a vector can be from the question, so the
      // person's own passage is always nearer.
      const vector = await questionVector(question);
      await brainOf(inJurisdiction(env, env.BRAIN_STORE)).putVectors({
        model: {
          name: vectorModelNameOf(await embedderModel()),
          centre: vector.map(() => 0),
        },
        vectors: [
          {
            chunk: { source: `upload:${ids.meant}`, version: 1, position: 0 },
            vector: vector.map((value) => -value),
          },
        ],
      });
      // Room for the three short passages and one token: never for a
      // citation as long as the person's own, or the last one's.
      const tokens =
        (["first", "second", "meant"] as const).reduce(
          (sum, key) =>
            sum +
            packItemTokens({
              source: `upload:${ids[key]}`,
              version: 1,
              position: 0,
              text: company[key],
              whole: true,
              found: "words",
            }),
          0
        ) + 1;

      const { pack, fromOwn } = await ownedByMeaning(
        personId,
        question,
        tokens
      );
      const { value: shared } = await recalledByMeaning(
        "the same turn as their teams",
        async () =>
          await recallAs(env, personId, {
            question,
            budget: { tokens },
            personal: false,
          })
      );
      const keyOf = (id: string) =>
        Object.entries(ids).find(([, each]) => each === id)?.[0] ?? id;

      expect({
        own: pack.items.map(({ source }) => keyOf(source.id)),
        shared: shared.items.map(({ source }) => keyOf(source.id)),
        truncated: [pack.truncated, shared.truncated],
        fromOwn,
      }).toStrictEqual({
        own: ["first", "second", "meant"],
        shared: ["first", "meant", "second"],
        truncated: [true, true],
        fromOwn: true,
      });
    }
  );
});
