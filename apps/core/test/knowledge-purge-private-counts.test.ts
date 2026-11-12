import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { InterviewProgress } from "@grasp-os/shared/interview-links";
import type { PurgeInput, PurgePlan } from "@grasp-os/shared/knowledge";
import type { Roster } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import { onLink } from "./interview-link.ts";
import { purged, rememberAs, saveOver, setUpTime } from "./knowledge-purge.ts";
import type { Person } from "./knowledge-purge.ts";
import { auditedDuring, signedInApi, unique } from "./sign-in.ts";

// A content purge and what people keep privately: their memory records,
// which only they read, their interviews, which the company may only see
// in groups, and their answers to the brain's gaps; a purge rewrites them
// all, whatever documents it names. The ways it can fail: an admin names
// a document of their own and tries a passage ("<name> + <fact>") as the
// term, and the plan, its audit record or the run's `stillFound` answers
// differently when someone's private records hold it; or, so as to say
// nothing, the purge stops erasing them.

const idp = mockIdp();

const personOf = async (role: "admin" | "user") => await signedInApi(idp, role);

/** Where someone keeps a passage privately. */
type Holder = "memory record" | "interview" | "gap answer";

const holders: readonly Holder[] = ["memory record", "interview", "gap answer"];

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

/** An interview in which the person said `passage`. */
const progressSaying = (passage: string): InterviewProgress => ({
  person: "progress",
  told: true,
  mode: "type",
  lines: [
    { from: "stephen", text: "Who covers for whom on your team?" },
    { from: "person", text: `Between us: ${passage}.`, typed: true },
  ],
  facts: [],
  phase: "steps",
  wants: "answer",
  startedAt: Date.now(),
  confirmed: 0,
  adding: false,
  addedAt: 0,
});

/** The key the interviewed person's device holds: 32 bytes, base64url. */
const deviceKey = "D".repeat(43);

/**
 * Someone interviewed who said `passage`: the link's secret, which with
 * `deviceKey` reads the interview as they do.
 */
const interviewSaying = async (passage: string): Promise<string> => {
  const store = onboardingStore(env);
  const lead = `lea-${unique()}`;
  const roster: Roster = {
    teams: [{ id: "sales", name: "Sales", lead, does: "", off: false }],
    people: [
      {
        id: lead,
        name: "Lea Lund",
        email: "lea@acme.test",
        team: "sales",
        title: "Head of Sales",
        away: false,
      },
    ],
  };
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(roster, by);
  await store.savePlan(
    { start: new Date().toISOString().slice(0, 10), days: 14 },
    by
  );
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  await store.releaseDue();
  const link = (await store.linkOf(lead)) ?? "";
  const secret = link.split("#")[1] ?? "";
  const key = await sha256Hex(deviceKey);
  await store.openLink(await sha256Hex(secret), null, key);
  await store.saveInterview(
    await sha256Hex(secret),
    key,
    0,
    progressSaying(passage)
  );
  return secret;
};

/** The interview as the person interviewed reads it, on their device. */
const interviewAsRead = async (secret: string): Promise<string> => {
  const response = await onLink({
    action: "session",
    secret,
    key: deviceKey,
  });
  return await response.text();
};

/**
 * Someone who keeps `passage` in `holder`, and an admin with a document of
 * their own holding nothing of it.
 */
const privatelyHeld = async (passage: string, holder: Holder) => {
  const admin = await personOf("admin");
  const member = await personOf("user");
  let gap = "";
  let secret = "";
  if (holder === "memory record") {
    await rememberAs(member, `Note to self: ${passage}.`);
  } else if (holder === "gap answer") {
    gap = await gapIn(admin, unique());
    await member.api.brain.answerGap(gap, `Ask around: ${passage}.`);
  } else {
    secret = await interviewSaying(passage);
  }
  const handbook = await admin.api.knowledge.createCollection({
    name: `Handbook ${unique()}`,
    access: "everyone",
  });
  const own = await saveOver(admin, handbook.id, "own.md", "# Own\nEmpty.");
  /** What `holder` holds now, as its owner reads it. */
  const read = async (): Promise<string> => {
    if (holder === "memory record") {
      const { records } = await member.api.knowledge.memoriesList();
      return JSON.stringify(records.map(({ statement }) => statement));
    }
    if (holder === "gap answer") {
      const workspace = await member.api.brain.read();
      return workspace.gaps.find(({ id }) => id === gap)?.answer ?? "";
    }
    return await interviewAsRead(secret);
  };
  return { admin, own, read };
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

describe("a content purge and people's private records", setUpTime, () => {
  it.each(holders)(
    "prepares a passage someone's %s holds exactly as one nobody holds, and audits it alike",
    async (holder) => {
      const tag = unique();
      const passage = `Mila Jansen ${tag} is expecting`;
      const { admin, own } = await privatelyHeld(passage, holder);
      const nowhere = `Mila Jansen ${tag} is moving`;
      const answers: { plan: unknown; detail: unknown }[] = [];
      for (const term of [passage, nowhere]) {
        const plans: PurgePlan[] = [];
        // oxlint-disable-next-line no-await-in-loop -- one try after another, as an admin would
        const events = await auditedDuring(async () => {
          plans.push(
            await admin.api.knowledge.preparePurge(purgeOf(own.id, term))
          );
        });
        const [plan] = plans;
        answers.push({
          plan: plan === undefined ? null : planOf(plan),
          detail: events.find(
            ({ action }) => action === "knowledge.purge.prepared"
          )?.detail,
        });
      }
      const [held, nobodys] = answers;
      expect(JSON.stringify(held)).toBe(JSON.stringify(nobodys));
    }
  );

  it.each(holders)(
    "still erases the passage from someone's %s, as they read it",
    async (holder) => {
      const tag = unique();
      const passage = `Ravi Kumar ${tag} is leaving`;
      const { admin, own, read } = await privatelyHeld(passage, holder);
      const before = await read();
      await purged(admin, purgeOf(own.id, passage));
      const after = await read();
      expect({
        before: before.includes(passage),
        after: after.includes(tag),
        removed: after.includes("(removed)"),
      }).toStrictEqual({ before: true, after: false, removed: true });
    }
  );

  it.each(holders)(
    "says after a run nothing of what someone's %s still holds",
    async (holder) => {
      const tag = unique();
      // A form the purge leaves on purpose ("Rene" for "René"): what a
      // run's check once counted.
      const { admin, own } = await privatelyHeld(`Rene Dubois ${tag}`, holder);
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
    }
  );
});
