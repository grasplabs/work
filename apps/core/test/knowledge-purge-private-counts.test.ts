import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import type { PurgeInput, PurgePlan } from "@grasp-os/shared/knowledge";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { purged, rememberAs, saveOver, setUpTime } from "./knowledge-purge.ts";
import type { Person } from "./knowledge-purge.ts";
import { auditedDuring, signedInApi, unique } from "./sign-in.ts";

// A content purge and what people keep privately: their memory records,
// which only they read, and Grasp's copies of their words (here a gap's
// answer), which a purge rewrites whatever documents it names. The ways it
// can fail: an admin names a document of their own and tries a passage
// ("<name> + <fact>") as the term, and the plan, its audit record or the
// run's `stillFound` answers differently when someone's private records
// hold it; or, so as to say nothing, the purge stops erasing them.

const idp = mockIdp();

const personOf = async (role: "admin" | "user") => await signedInApi(idp, role);

/** A gap in the brain, noticed in an interview, for someone to answer. */
const gapIn = async (admin: Person, tag: string): Promise<string> => {
  const records: BrainRecordInput[] = [
    {
      type: "source",
      id: `src-${tag}`,
      kind: "interview",
      title: "Finance interview",
      date: "2026-10-20",
    },
    { type: "candidate", id: `cand-${tag}`, name: "Invoice entry" },
    {
      type: "gap",
      id: `gap-${tag}`,
      question: "Who covers invoices?",
      owner: "Head of finance",
      sourceId: `src-${tag}`,
      about: [`cand-${tag}`],
    },
  ];
  await admin.api.brain.addRecords(records);
  return `gap-${tag}`;
};

/**
 * Someone whose own memory record holds `passage`, and whose answer to a
 * gap does too; an admin with a document of their own, holding neither.
 */
const privatelyHeld = async (passage: string) => {
  const admin = await personOf("admin");
  const member = await personOf("user");
  await rememberAs(member, `Note to self: ${passage}.`);
  const gap = await gapIn(admin, unique());
  await member.api.brain.answerGap(gap, `Ask around: ${passage}.`);
  const handbook = await admin.api.knowledge.createCollection({
    name: `Handbook ${unique()}`,
    access: "everyone",
  });
  const own = await saveOver(admin, handbook.id, "own.md", "# Own\nEmpty.");
  return { admin, member, gap, own };
};

/** A content purge of `documentId` for `term`. */
const purgeOf = (documentId: string, term: string): PurgeInput => ({
  type: "content",
  documentIds: [documentId],
  terms: [term],
  reason: "erasure_request",
});

/** A plan without what tells one confirmation from another. */
const planOf = ({ token, expiresAt, ...rest }: PurgePlan) => {
  expect({ token: typeof token, expiresAt: typeof expiresAt }).toStrictEqual({
    token: "string",
    expiresAt: "string",
  });
  return rest;
};

/** `member`'s own memory statements. */
const statementsOf = async (member: Person): Promise<string[]> => {
  const { records } = await member.api.knowledge.memoriesList();
  return records.map(({ statement }) => statement);
};

describe("a content purge and people's private records", setUpTime, () => {
  it("prepares a passage someone's private records hold exactly as one nobody holds, and audits it alike", async () => {
    const tag = unique();
    const passage = `Mila Jansen ${tag} is expecting`;
    const { admin, own } = await privatelyHeld(passage);
    const nowhere = `Mila Jansen ${tag} is moving`;
    const answers: { plan: unknown; detail: unknown }[] = [];
    for (const term of [passage, nowhere]) {
      let plan: PurgePlan | undefined;
      // oxlint-disable-next-line no-await-in-loop -- one try after another, as an admin would
      const events = await auditedDuring(async () => {
        plan = await admin.api.knowledge.preparePurge(purgeOf(own.id, term));
      });
      answers.push({
        plan: plan === undefined ? null : planOf(plan),
        detail: events.find(
          ({ action }) => action === "knowledge.purge.prepared"
        )?.detail,
      });
    }
    const [held, nobodys] = answers;
    expect(JSON.stringify(held)).toBe(JSON.stringify(nobodys));
  });

  it("still erases the passage from someone's memory records and their answers, as they read them", async () => {
    const tag = unique();
    const passage = `Ravi Kumar ${tag} is leaving`;
    const { admin, member, gap, own } = await privatelyHeld(passage);
    await purged(admin, purgeOf(own.id, passage));
    const statements = await statementsOf(member);
    const workspace = await member.api.brain.read();
    const answer = workspace.gaps.find(({ id }) => id === gap)?.answer;
    expect({
      statements: statements.filter((each) => each.includes(tag)),
      held: statements.some((each) => each.includes(passage)),
      answer,
    }).toStrictEqual({
      statements: [],
      held: false,
      answer: "Ask around: (removed).",
    });
  });

  it("says after a run nothing of what someone's private records still hold", async () => {
    const tag = unique();
    // A form the purge leaves on purpose ("Rene" for "René"), in a record
    // and an answer: what a run's check once counted.
    const { admin, own } = await privatelyHeld(`Rene Dubois ${tag}`);
    const results: unknown[] = [];
    for (const term of [`René Dubois ${tag}`, `René Martin ${tag}`]) {
      // oxlint-disable-next-line no-await-in-loop -- one run after another
      const { result } = await purged(admin, purgeOf(own.id, term));
      results.push({
        documents: result.documents,
        versions: result.versions,
        stillFound: result.stillFound,
      });
    }
    const [held, nobodys] = results;
    expect(held).toStrictEqual(nobodys);
  });
});
