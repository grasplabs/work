import { describe, expect, it } from "vite-plus/test";

import type { CollectionRow } from "../src/collections.ts";
import { brainErrors } from "../src/contract.ts";
import type { SkillSelection } from "../src/contract.ts";
import { writeVersion } from "../src/documents.ts";
import { collectionIdSchema } from "../src/ids.ts";
import { knowledgeErrors } from "../src/knowledge.ts";
import {
  readSkill,
  readSkillWithSources,
  selectSkill,
  selectSkillWithSources,
  skillsReadMax,
} from "../src/skills.ts";
import type { Caller } from "./host.ts";
import { newCollection, testHost, writerOf } from "./host.ts";

// Selecting a skill for a task, and reading the one pinned, at the Brain's
// boundary. The ways it could fail its host, tried below (GRA-310):
// 1. A skill is selected the caller couldn't use: one needing a capability
//    they lack, or in a collection they can't read (named, even).
// 2. A missing prerequisite or dependency still selects the skill.
// 3. A skill is forced: chosen because it exists, by resemblance, or out
//    of two that both apply.
// 4. A pin moves: a newer version, or retiring the skill, changes what a
//    run that pinned it reads; or a pinned read outlives the caller's
//    access to it.
// 5. A retired skill, or one past the read limit, is still selected.
// 6. A forged field in the task widens what the caller may do.
// 7. A selection, a no-skill one too, goes unrecorded.

const { brain, reads } = testHost();

/** A `SKILL.md` with `manifest` in its frontmatter. */
const skillText = (name: string, manifest: string): string =>
  `---\nname: ${name}\ndescription: Does ${name}.\n${manifest}\n---\n\n# ${name}\n\nDo it well.\n`;

/** Saves the skill `name` in `collection`, over `ifVersion`. */
const saved = async (
  collection: CollectionRow,
  name: string,
  manifest: string,
  ifVersion = 0
) =>
  await writeVersion(brain, writerOf("writer"), {
    collection,
    path: `${name}/SKILL.md`,
    text: skillText(name, manifest),
    ifVersion,
    message: null,
    restoredFrom: null,
  });

/** What a selection came to: the skill's name, or why none, with each considered. */
const summary = (selection: SkillSelection) => ({
  result:
    selection.result.kind === "skill"
      ? selection.result.skill.name
      : selection.result.reason,
  considered: Object.fromEntries(
    selection.considered.map(({ skill, outcome }) => [skill.name, outcome])
  ),
});

/** `pairs`, by their first item. */
const sorted = (pairs: string[][]) =>
  pairs.toSorted(([a = ""], [b = ""]) => a.localeCompare(b));

/** Where a selection's skill came from, or why none, with where each considered one is. */
const where = (selection: SkillSelection) => ({
  result:
    selection.result.kind === "skill"
      ? selection.result.skill.collectionId
      : selection.result.reason,
  considered: selection.considered.map((each) => [
    each.skill.collectionId,
    each.outcome,
  ]),
});

/** The code `promise` refused with, or "ok". */
const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return (
      brainErrors.codeOf(error) ?? knowledgeErrors.codeOf(error) ?? "unknown"
    );
  }
};

describe("selecting a skill", () => {
  it("selects the one skill whose manifest applies, and pins the version it read", async () => {
    const skills = await newCollection(brain, "Skills");
    const refunds = await saved(skills, "refunds", "tasks: [refund]");
    await saved(skills, "disputes", "tasks: [payment-dispute]");
    const caller: Caller = { userId: "ann", reads: [skills.id] };

    const selection = await selectSkill(brain, caller, {
      task: { type: "refund" },
    });

    expect({
      ...summary(selection),
      pinned:
        selection.result.kind === "skill"
          ? {
              documentId: selection.result.skill.documentId,
              version: selection.result.skill.version,
            }
          : null,
    }).toStrictEqual({
      result: "refunds",
      considered: { refunds: "selected" },
      pinned: { documentId: refunds.id, version: 1 },
    });
  });

  it("selects none rather than force one: none applies, two apply, or one only resembles the task", async () => {
    const skills = await newCollection(brain, "Skills");
    await saved(skills, "refund-desk", "tasks: [refund-desk]");
    await saved(skills, "refunds-eu", "tasks: [refund]");
    await saved(skills, "refunds-us", "tasks: [refund]");
    await saved(skills, "no-tasks", "when: [refund]");
    const caller: Caller = { userId: "ann", reads: [skills.id] };

    const resembling = await selectSkill(brain, caller, {
      task: { type: "refunds" },
    });
    const two = await selectSkill(brain, caller, { task: { type: "refund" } });

    expect([summary(resembling), summary(two)]).toStrictEqual([
      { result: "no_match", considered: {} },
      {
        result: "ambiguous",
        considered: { "refunds-eu": "ambiguous", "refunds-us": "ambiguous" },
      },
    ]);
  });

  it("lets a skill take another's place only where both apply, never by order", async () => {
    const skills = await newCollection(brain, "Skills");
    await saved(skills, "refunds", "tasks: [refund]");
    await saved(skills, "our-refunds", "tasks: [refund]\nreplaces: [refunds]");
    await saved(
      skills,
      "eu-refunds",
      "tasks: [refund]\nwhen: [eu]\nreplaces: [our-refunds]"
    );
    const caller: Caller = { userId: "ann", reads: [skills.id] };

    const anywhere = await selectSkill(brain, caller, {
      task: { type: "refund" },
    });
    const inEu = await selectSkill(brain, caller, {
      task: { type: "refund", traits: ["eu"] },
    });

    expect([summary(anywhere), summary(inEu)]).toStrictEqual([
      {
        result: "our-refunds",
        considered: {
          "eu-refunds": "precondition_unmet",
          "our-refunds": "selected",
          refunds: "replaced",
        },
      },
      {
        result: "eu-refunds",
        considered: {
          "eu-refunds": "selected",
          "our-refunds": "replaced",
          refunds: "replaced",
        },
      },
    ]);
  });

  it("never selects a skill needing a capability the caller lacks, nor one they can't read, and names neither", async () => {
    const open = await newCollection(brain, "Open skills");
    const closed = await newCollection(brain, "Closed skills");
    await saved(open, "payouts", "tasks: [payout]\nrequires: [connector:bank]");
    await saved(closed, "payouts-hidden", "tasks: [payout]");
    const without: Caller = { userId: "ann", reads: [open.id] };
    const holding: Caller = {
      userId: "bo",
      reads: [open.id],
      capabilities: ["connector:bank"],
    };

    const lacking = await selectSkill(brain, without, {
      task: { type: "payout" },
    });
    const held = await selectSkill(brain, holding, {
      task: { type: "payout" },
    });
    // A forged field can't say what the caller holds.
    const forged = await outcome(
      selectSkill(brain, without, {
        task: { type: "payout" },
        capabilities: ["connector:bank"],
      })
    );

    expect({
      lacking: summary(lacking),
      held: summary(held),
      forged,
    }).toStrictEqual({
      lacking: {
        result: "no_match",
        considered: { payouts: "missing_capability" },
      },
      held: { result: "payouts", considered: { payouts: "selected" } },
      forged: "brain.invalid",
    });
  });

  it("selects a skill only with its prerequisites usable and its dependencies readable at their versions", async () => {
    const skills = await newCollection(brain, "Skills");
    const extra = await newCollection(brain, "Extra skills");
    await saved(
      skills,
      "close-month",
      `tasks: [close]\nprerequisites: [{ collection: "${extra.id}", name: reconcile }]`
    );
    await saved(
      skills,
      "report",
      `tasks: [report]\ndependencies: [{ collection: "${extra.id}", name: ledger, version: 2 }]`
    );
    await saved(
      extra,
      "reconcile",
      "tasks: [reconcile]\nrequires: [connector:bank]"
    );
    const ledger = await saved(extra, "ledger", "tasks: [ledger]");
    const narrow: Caller = { userId: "ann", reads: [skills.id] };
    const wide: Caller = {
      userId: "bo",
      reads: [skills.id, extra.id],
      capabilities: ["connector:bank"],
    };
    const wideLacking: Caller = { userId: "cy", reads: [skills.id, extra.id] };

    const unreadable = await selectSkill(brain, narrow, {
      task: { type: "close" },
    });
    const lackingPrerequisite = await selectSkill(brain, wideLacking, {
      task: { type: "close" },
    });
    const usable = await selectSkill(brain, wide, { task: { type: "close" } });
    const beforeVersion = await selectSkill(brain, wide, {
      task: { type: "report" },
    });
    await saved(
      extra,
      "ledger",
      "tasks: [ledger]\nacceptance: [ledger-suite]",
      1
    );
    const atVersion = await selectSkill(brain, wide, {
      task: { type: "report" },
    });

    expect({
      unreadable: summary(unreadable).considered,
      lackingPrerequisite: summary(lackingPrerequisite).considered,
      usable: summary(usable).result,
      beforeVersion: summary(beforeVersion).considered,
      atVersion:
        atVersion.result.kind === "skill"
          ? atVersion.result.dependencies.map(({ documentId, version }) => ({
              documentId,
              version,
            }))
          : atVersion.result.reason,
    }).toStrictEqual({
      unreadable: { "close-month": "prerequisite_missing" },
      lackingPrerequisite: { "close-month": "prerequisite_missing" },
      usable: "close-month",
      beforeVersion: { report: "dependency_missing" },
      atVersion: [{ documentId: ledger.id, version: 2 }],
    });
  });

  it("takes a retired skill and an excluded one out of selection at once", async () => {
    const skills = await newCollection(brain, "Skills");
    await saved(skills, "refunds", "tasks: [refund]\nunless: [disputed]");
    const caller: Caller = { userId: "ann", reads: [skills.id] };

    const disputed = await selectSkill(brain, caller, {
      task: { type: "refund", traits: ["disputed"] },
    });
    await saved(skills, "refunds", "tasks: [refund]\nstatus: retired", 1);
    const retired = await selectSkill(brain, caller, {
      task: { type: "refund" },
    });

    expect([summary(disputed), summary(retired)]).toStrictEqual([
      { result: "no_match", considered: { refunds: "excluded" } },
      { result: "no_match", considered: { refunds: "retired" } },
    ]);
  });

  it("selects none from more skills than it reads, rather than choose from a part", async () => {
    const skills = await newCollection(brain, "Many skills");
    for (let index = 0; index <= skillsReadMax; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one save at a time
      await saved(skills, `skill-${index}`, "tasks: [other]");
    }
    await saved(skills, "zz-refunds", "tasks: [refund]");
    const caller: Caller = { userId: "ann", reads: [skills.id] };

    const selection = await selectSkill(brain, caller, {
      task: { type: "refund" },
    });

    expect(summary(selection)).toStrictEqual({
      result: "incomplete",
      considered: {},
    });
  });

  it("records every selection, a no-skill one too, with its result and counts, never a skill's text", async () => {
    const skills = await newCollection(brain, "Skills");
    await saved(skills, "refunds", "tasks: [refund]");
    const caller: Caller = { userId: "recorded", reads: [skills.id] };

    await selectSkill(brain, caller, { task: { type: "refund" } });
    await selectSkill(brain, caller, { task: { type: "payroll" } });

    const recorded = reads
      .filter(
        ({ caller: who, record }) =>
          who === "recorded" && record.action === "knowledge.skill.select"
      )
      .map(({ record }) => ({
        task: record.detail.task,
        result: record.detail.result,
        reason: record.detail.reason,
        considered: record.detail.considered,
        texts: JSON.stringify(record).includes("Do it well"),
      }));
    expect(recorded).toStrictEqual([
      {
        task: "refund",
        result: "skill",
        reason: null,
        considered: 1,
        texts: false,
      },
      {
        task: "payroll",
        result: "none",
        reason: "no_match",
        considered: 0,
        texts: false,
      },
    ]);
  });
});

describe("who can make a skill selectable", () => {
  it("never selects a skill in a collection members write, whatever its status says", async () => {
    const team = await newCollection(brain, "Team skills", "team");
    await saved(team, "refunds", "tasks: [refund]\nstatus: accepted");
    const caller: Caller = { userId: "ann", reads: [team.id] };

    const selection = await selectSkill(brain, caller, {
      task: { type: "refund" },
    });

    expect(summary(selection)).toStrictEqual({
      result: "no_match",
      considered: {},
    });
  });

  // A thousand saves, one at a time, outrun the default timeout on CI.
  const fillTimeout = 60_000;

  it(
    "lets no team collection full of skills stop a company skill being selected",
    { timeout: fillTimeout },
    async () => {
      const company = await newCollection(brain, "Company skills");
      const team = await newCollection(brain, "Team skills", "team");
      await saved(company, "invoices", "tasks: [invoice]");
      // More skill documents than any cap: none counts, as none is vouched for.
      for (let index = 0; index <= 1000; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one save at a time
        await saved(team, `filler-${index}`, "tasks: [invoice]");
      }
      const teammate: Caller = { userId: "ann", reads: [company.id, team.id] };

      const selection = await selectSkill(brain, teammate, {
        task: { type: "invoice" },
      });

      expect(summary(selection)).toStrictEqual({
        result: "invoices",
        considered: { invoices: "selected" },
      });
    }
  );

  it("refuses a teammate's skill taking the company's place through replaces", async () => {
    const company = await newCollection(brain, "Company skills");
    const team = await newCollection(brain, "Team skills", "team");
    const other = await newCollection(brain, "Other company skills");
    await saved(company, "invoice-review", "tasks: [invoice]");
    await saved(
      team,
      "invoice-review-fast",
      "tasks: [invoice]\nreplaces: [invoice-review]"
    );
    await saved(
      other,
      "invoice-review-other",
      "tasks: [audit]\nreplaces: [invoice-review]"
    );
    const teammate: Caller = { userId: "ann", reads: [company.id, team.id] };
    const both: Caller = { userId: "bo", reads: [company.id, other.id] };

    const throughTeam = await selectSkill(brain, teammate, {
      task: { type: "invoice" },
    });
    await saved(
      other,
      "invoice-review-other",
      "tasks: [invoice]\nreplaces: [invoice-review]",
      1
    );
    // An admins' collection replaces only within itself, or a shipped skill.
    const acrossAdmins = await selectSkill(brain, both, {
      task: { type: "invoice" },
    });

    expect([summary(throughTeam), summary(acrossAdmins)]).toStrictEqual([
      {
        result: "invoice-review",
        considered: { "invoice-review": "selected" },
      },
      {
        result: "ambiguous",
        considered: {
          "invoice-review": "ambiguous",
          "invoice-review-other": "ambiguous",
        },
      },
    ]);
  });

  it("lets a skill in a collection only admins write take a shipped skill's place", async () => {
    const shipped = await newCollection(brain, "Shipped skills", "shipped");
    const company = await newCollection(brain, "Company skills");
    const team = await newCollection(brain, "Team skills", "team");
    await saved(shipped, "baseline", "tasks: [baseline]");
    await saved(
      company,
      "our-baseline",
      "tasks: [baseline]\nreplaces: [baseline]"
    );
    await saved(
      team,
      "team-baseline",
      "tasks: [baseline]\nreplaces: [baseline]"
    );
    const caller: Caller = {
      userId: "ann",
      reads: [shipped.id, company.id, team.id],
    };

    const selection = await selectSkill(brain, caller, {
      task: { type: "baseline" },
    });

    expect(summary(selection)).toStrictEqual({
      result: "our-baseline",
      considered: { baseline: "replaced", "our-baseline": "selected" },
    });
  });

  it("counts a prerequisite only once it is usable in turn: its own dependencies resolve, and no chain of them loops", async () => {
    const company = await newCollection(brain, "Company skills");
    await saved(
      company,
      "close-month",
      "tasks: [close]\nprerequisites: [reconcile]"
    );
    await saved(
      company,
      "reconcile",
      "tasks: [reconcile]\ndependencies: [ledger@2]"
    );
    await saved(company, "ledger", "tasks: [ledger]");
    // Two that each need the other first.
    await saved(
      company,
      "open-books",
      "tasks: [open]\nprerequisites: [check-books]"
    );
    await saved(
      company,
      "check-books",
      "tasks: [check]\nprerequisites: [open-books]"
    );
    const caller: Caller = { userId: "ann", reads: [company.id] };
    const select = async (type: string) =>
      summary(await selectSkill(brain, caller, { task: { type } }));
    const withoutLedger = await select("close");
    const loop = await select("open");
    await saved(company, "ledger", "tasks: [ledger]\nacceptance: [suite]", 1);

    expect({
      withoutLedger,
      loop,
      withLedger: await select("close"),
    }).toStrictEqual({
      withoutLedger: {
        result: "no_match",
        considered: { "close-month": "prerequisite_missing" },
      },
      loop: {
        result: "no_match",
        considered: { "open-books": "prerequisite_missing" },
      },
      withLedger: {
        result: "close-month",
        considered: { "close-month": "selected" },
      },
    });
  });

  it("works out each prerequisite once a selection, and selects none past its bound of skills visited", async () => {
    const company = await newCollection(brain, "Company skills");
    // Each needs every one of the (up to 16) before it: as a tree of
    // chains, far more than any bound; worked out once each, a few hundred.
    const chain = async (prefix: string, length: number) => {
      for (let index = 0; index < length; index += 1) {
        const before = Array.from(
          { length: Math.min(index, 16) },
          (_, back) => `${prefix}-${index - back - 1}`
        );
        // oxlint-disable-next-line no-await-in-loop -- one save at a time
        await saved(
          company,
          `${prefix}-${index}`,
          `tasks: [${prefix}-${index}]${before.length === 0 ? "" : `\nprerequisites: [${before.join(", ")}]`}`
        );
      }
    };
    await chain("small", 12);
    await chain("dense", 40);
    // One that applies too, weighed before the dense one runs out.
    await saved(company, "a-plain", "tasks: [dense-39]");
    const caller: Caller = { userId: "ann", reads: [company.id] };

    const small = await selectSkill(brain, caller, {
      task: { type: "small-11" },
    });
    const dense = await selectSkill(brain, caller, {
      task: { type: "dense-39" },
    });

    expect({
      results: [small.result, dense.result].map((result) =>
        result.kind === "skill" ? result.skill.name : result.reason
      ),
      // Nothing it weighed says selected when it selected none.
      dense: summary(dense).considered,
    }).toStrictEqual({
      results: ["small-11", "incomplete"],
      dense: { "a-plain": "incomplete", "dense-39": "prerequisite_missing" },
    });
  });

  it("lets an admins' copy of a shipped skill, under its name, take its place, and a team's never", async () => {
    const shipped = await newCollection(brain, "Shipped skills", "shipped");
    const company = await newCollection(brain, "Company skills");
    const team = await newCollection(brain, "Team skills", "team");
    await saved(shipped, "onboarding", "tasks: [onboard]");
    await saved(team, "onboarding", "tasks: [onboard]\nstatus: accepted");
    const teammate: Caller = { userId: "ann", reads: [shipped.id, team.id] };
    const byTeam = await selectSkill(brain, teammate, {
      task: { type: "onboard" },
    });
    // The company's adapted copy: the same name, which it can't name in
    // `replaces`.
    await saved(company, "onboarding", "tasks: [onboard]");
    const everyone: Caller = {
      userId: "bo",
      reads: [shipped.id, company.id, team.id],
    };

    const byCompany = await selectSkill(brain, everyone, {
      task: { type: "onboard" },
    });

    // Narrowed to the EU, and then retired: either way the shipped one
    // stays out, and nothing is selected in its place.
    await saved(company, "onboarding", "tasks: [onboard]\nwhen: [eu]", 1);
    const narrowed = await selectSkill(brain, everyone, {
      task: { type: "onboard" },
    });
    await saved(company, "onboarding", "tasks: [onboard]\nstatus: retired", 2);
    const retired = await selectSkill(brain, everyone, {
      task: { type: "onboard" },
    });

    expect([
      where(byTeam),
      where(byCompany),
      where(narrowed),
      where(retired),
    ]).toStrictEqual([
      { result: shipped.id, considered: [[shipped.id, "selected"]] },
      {
        result: company.id,
        considered: sorted([
          [company.id, "selected"],
          [shipped.id, "replaced"],
        ]),
      },
      {
        result: "no_match",
        considered: sorted([
          [company.id, "precondition_unmet"],
          [shipped.id, "replaced"],
        ]),
      },
      {
        result: "no_match",
        considered: sorted([
          [company.id, "retired"],
          [shipped.id, "replaced"],
        ]),
      },
    ]);
  });

  it("weighs and reads only skills in the collections a bound caller is bound to, and records no read outside them", async () => {
    const bound = await newCollection(brain, "Bound skills");
    const other = await newCollection(brain, "Other skills");
    await saved(bound, "triage", "tasks: [triage]");
    const elsewhere = await saved(other, "refund", "tasks: [refund]");
    const caller: Caller = { userId: "cy", reads: [bound.id, other.id] };
    const select = async (type: string, within: string[]) => {
      const { selection, provenance } = await selectSkillWithSources(
        brain,
        caller,
        { task: { type } },
        within.map((id) => collectionIdSchema.parse(id))
      );
      return {
        result:
          selection.result.kind === "skill"
            ? selection.result.skill.name
            : selection.result.reason,
        from: provenance.collectionIds,
      };
    };
    const readsBefore = reads.length;
    const outside = await outcome(
      readSkillWithSources(
        brain,
        caller,
        { documentId: elsewhere.id, version: 1 },
        [collectionIdSchema.parse(bound.id)]
      )
    );
    const readsAfterOutside = reads.length;

    expect({
      triage: await select("triage", [bound.id]),
      refund: await select("refund", [bound.id]),
      none: await select("triage", []),
      outside,
      recordedOutside: readsAfterOutside - readsBefore,
    }).toStrictEqual({
      triage: { result: "triage", from: [bound.id] },
      refund: { result: "no_match", from: [bound.id] },
      none: { result: "no_match", from: [] },
      outside: "brain.not_found",
      recordedOutside: 0,
    });
  });

  it("refuses a teammate's skill standing in for a company skill's dependency or prerequisite", async () => {
    const company = await newCollection(brain, "Company skills");
    const hidden = await newCollection(brain, "Admins' skills");
    const team = await newCollection(brain, "Team skills", "team");
    await saved(
      company,
      "report",
      `tasks: [report]\ndependencies: [{ collection: "${hidden.id}", name: rules, version: 2 }]`
    );
    await saved(
      company,
      "close-month",
      "tasks: [close]\nprerequisites: [approve]"
    );
    // The rules and the approval the company means live where members
    // can't read; a teammate writes their own under the same names.
    await saved(hidden, "rules", "tasks: [rules]");
    await saved(hidden, "rules", "tasks: [rules]\nacceptance: [suite]", 1);
    await saved(team, "rules", "tasks: [rules]");
    await saved(team, "rules", "tasks: [rules]\nacceptance: [mine]", 1);
    await saved(team, "approve", "tasks: [approve]");
    const teammate: Caller = { userId: "ann", reads: [company.id, team.id] };

    const report = await selectSkill(brain, teammate, {
      task: { type: "report" },
    });
    const close = await selectSkill(brain, teammate, {
      task: { type: "close" },
    });

    expect([summary(report), summary(close)]).toStrictEqual([
      { result: "no_match", considered: { report: "dependency_missing" } },
      {
        result: "no_match",
        considered: { "close-month": "prerequisite_missing" },
      },
    ]);
  });

  it("pins a dependency at exactly the version named: one that isn't there, renamed or retired at it, is missing", async () => {
    const skills = await newCollection(brain, "Skills");
    await saved(skills, "ledger", "tasks: [ledger]");
    await saved(skills, "ledger", "tasks: [ledger]\nstatus: retired", 1);
    await saved(skills, "later", "tasks: [later]\ndependencies: [ledger@3]");
    await saved(
      skills,
      "retired-at",
      "tasks: [retired]\ndependencies: [ledger@2]"
    );
    await saved(skills, "exact", "tasks: [exact]\ndependencies: [ledger@1]");
    const caller: Caller = { userId: "ann", reads: [skills.id] };

    const select = async (type: string) =>
      summary(await selectSkill(brain, caller, { task: { type } }));

    const later = await select("later");
    const retiredAt = await select("retired");
    const exact = await select("exact");
    expect([later, retiredAt, exact.result]).toStrictEqual([
      { result: "no_match", considered: { later: "dependency_missing" } },
      {
        result: "no_match",
        considered: { "retired-at": "dependency_missing" },
      },
      "exact",
    ]);
  });

  it("treats a name twice in a collection as ambiguous, never as whichever is read", async () => {
    const skills = await newCollection(brain, "Skills");
    await saved(
      skills,
      "close-month",
      "tasks: [close]\nprerequisites: [approve]"
    );
    await writeVersion(brain, writerOf("writer"), {
      collection: skills,
      path: "approve/SKILL.md",
      text: skillText("approve", "tasks: [approve]"),
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    await writeVersion(brain, writerOf("writer"), {
      collection: skills,
      path: "approve-copy/SKILL.md",
      text: skillText("approve", "tasks: [approve]"),
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    // A skill naming its own name, in its own collection by ID, where
    // another has that name too: ambiguous, never the other one.
    await writeVersion(brain, writerOf("writer"), {
      collection: skills,
      path: "settle/SKILL.md",
      text: skillText(
        "settle",
        `tasks: [settle]\nprerequisites: [{ collection: "${skills.id}", name: settle }]`
      ),
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    await writeVersion(brain, writerOf("writer"), {
      collection: skills,
      path: "settle-copy/SKILL.md",
      text: skillText("settle", "tasks: [other]"),
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    const caller: Caller = { userId: "ann", reads: [skills.id] };

    const selection = await selectSkill(brain, caller, {
      task: { type: "close" },
    });
    const settle = await selectSkill(brain, caller, {
      task: { type: "settle" },
    });

    expect([summary(selection).considered, summary(settle)]).toStrictEqual([
      { "close-month": "prerequisite_missing" },
      { result: "no_match", considered: { settle: "prerequisite_missing" } },
    ]);
  });

  it("replaces nothing through a name that is ambiguous, and a replacement never settles an ambiguity", async () => {
    const shipped = await newCollection(brain, "Shipped skills", "shipped");
    const company = await newCollection(brain, "Company skills");
    /** Saves a skill named `name` at its own `path` in `collection`. */
    const at = async (
      collection: CollectionRow,
      path: string,
      name: string,
      manifest: string
    ) =>
      await writeVersion(brain, writerOf("writer"), {
        collection,
        path: `${path}/SKILL.md`,
        text: skillText(name, manifest),
        ifVersion: 0,
        message: null,
        restoredFrom: null,
      });
    // `review` twice in one collection, and one replacing it.
    await at(company, "review-a", "review", "tasks: [audit]");
    await at(company, "review-b", "review", "tasks: [audit]");
    await at(
      company,
      "review-fast",
      "review-fast",
      "tasks: [audit]\nreplaces: [review]"
    );
    // `base` in the company's collection and in a shipped one: replacing
    // `base` from the company's could mean either.
    await at(shipped, "base", "base", "tasks: [base]");
    await at(company, "base", "base", "tasks: [base]");
    await at(
      company,
      "base-ours",
      "base-ours",
      "tasks: [base]\nreplaces: [base]"
    );
    // `close` replaced by two skills of one name: the target goes, the two
    // left are ambiguous.
    await at(company, "close", "close", "tasks: [close]");
    await at(
      company,
      "close-a",
      "close-fast",
      "tasks: [close]\nreplaces: [close]"
    );
    await at(
      company,
      "close-b",
      "close-fast",
      "tasks: [close]\nreplaces: [close]"
    );
    // A replacement that can't be used itself replaces nothing.
    await at(company, "pay", "pay", "tasks: [pay]");
    await at(
      company,
      "pay-new",
      "pay-new",
      "tasks: [pay]\nprerequisites: [missing]\nreplaces: [pay]"
    );
    const caller: Caller = { userId: "ann", reads: [shipped.id, company.id] };
    const select = async (type: string) => {
      const selection = await selectSkill(brain, caller, { task: { type } });
      return {
        result:
          selection.result.kind === "skill"
            ? selection.result.skill.name
            : selection.result.reason,
        considered: selection.considered
          .map((each) => `${each.skill.name}: ${each.outcome}`)
          .toSorted(),
      };
    };

    expect({
      audit: await select("audit"),
      base: await select("base"),
      close: await select("close"),
      pay: await select("pay"),
    }).toStrictEqual({
      audit: {
        result: "ambiguous",
        considered: [
          "review-fast: ambiguous",
          "review: ambiguous",
          "review: ambiguous",
        ],
      },
      // The company's own `base` is the shipped one's adapted copy and takes
      // its place; `base-ours` still can't say which `base` it means.
      base: {
        result: "ambiguous",
        considered: [
          "base-ours: ambiguous",
          "base: ambiguous",
          "base: replaced",
        ],
      },
      close: {
        result: "ambiguous",
        considered: [
          "close-fast: ambiguous",
          "close-fast: ambiguous",
          "close: replaced",
        ],
      },
      pay: {
        result: "pay",
        considered: ["pay-new: prerequisite_missing", "pay: selected"],
      },
    });
  });
});

describe("reading a pinned skill", () => {
  it("returns the pinned version as it was, after a newer one and after retiring it, while the caller may read it", async () => {
    const skills = await newCollection(brain, "Skills");
    await saved(skills, "refunds", "tasks: [refund]");
    const caller: Caller = { userId: "ann", reads: [skills.id] };
    const selection = await selectSkill(brain, caller, {
      task: { type: "refund" },
    });
    if (selection.result.kind !== "skill") {
      throw new Error("Nothing selected");
    }
    const { skill } = selection.result;
    await saved(skills, "refunds", "tasks: [refund]\nwhen: [new]", 1);
    await saved(skills, "refunds", "tasks: [refund]\nstatus: retired", 2);

    const pinned = await readSkill(brain, caller, {
      documentId: skill.documentId,
      version: skill.version,
    });
    const revoked = await outcome(
      readSkill(
        brain,
        { userId: "ann", reads: [] },
        { documentId: skill.documentId, version: skill.version }
      )
    );

    expect({
      version: pinned.skill.version,
      manifest: pinned.manifest
        ? { when: pinned.manifest.when, status: pinned.manifest.status }
        : null,
      text: pinned.text.includes("when:"),
      revoked,
    }).toStrictEqual({
      version: 1,
      manifest: { when: [], status: "accepted" },
      text: false,
      revoked: "brain.not_found",
    });
  });

  it("reads only skills, by the pinned version's own type: another document, a version that isn't there, or one that wasn't a skill is not found", async () => {
    const skills = await newCollection(brain, "Skills");
    const skill = await saved(skills, "refunds", "tasks: [refund]");
    const note = await writeVersion(brain, writerOf("writer"), {
      collection: skills,
      path: "note.md",
      text: "# A note",
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    const written = async (path: string, text: string, ifVersion: number) =>
      await writeVersion(brain, writerOf("writer"), {
        collection: skills,
        path,
        text,
        ifVersion,
        message: null,
        restoredFrom: null,
      });
    // A skill that became a plain document since its pin, and a plain
    // document that became a skill.
    const became = await saved(skills, "payouts", "tasks: [payout]");
    await written("payouts/SKILL.md", "---\ntype: doc\n---\n# Payouts", 1);
    const was = await written(
      "audits/SKILL.md",
      "---\ntype: doc\n---\n# Audits",
      0
    );
    await written("audits/SKILL.md", skillText("audits", "tasks: [audit]"), 1);
    // A skill a team writes, "accepted" or not: never read as a vetted one.
    const team = await newCollection(brain, "Team skills", "team");
    const teams = await saved(
      team,
      "shortcut",
      "tasks: [refund]\nstatus: accepted"
    );
    const caller: Caller = { userId: "ann", reads: [skills.id, team.id] };
    const pinned = await readSkill(brain, caller, {
      documentId: became.id,
      version: 1,
    });

    expect({
      note: await outcome(
        readSkill(brain, caller, { documentId: note.id, version: 1 })
      ),
      later: await outcome(
        readSkill(brain, caller, { documentId: skill.id, version: 2 })
      ),
      pinnedSince: { name: pinned.skill.name, version: pinned.skill.version },
      notYet: await outcome(
        readSkill(brain, caller, { documentId: was.id, version: 1 })
      ),
      team: await outcome(
        readSkill(brain, caller, { documentId: teams.id, version: 1 })
      ),
    }).toStrictEqual({
      note: "brain.not_found",
      later: "brain.not_found",
      pinnedSince: { name: "payouts", version: 1 },
      notYet: "brain.not_found",
      team: "brain.not_found",
    });
  });
});

describe("a skill's manifest", () => {
  it("requires a capability by the host's own name for it, case and length kept", async () => {
    const skills = await newCollection(brain, "Skills");
    const long = `connection:${"c".repeat(256)}:${"SEND_".repeat(12)}MAIL`;
    await saved(
      skills,
      "mailing",
      `tasks: [mail]\nrequires: [connection:MAIL_SEND, "${long}"]`
    );
    const select = async (capabilities: string[]) =>
      summary(
        await selectSkill(
          brain,
          { userId: "ann", reads: [skills.id], capabilities },
          { task: { type: "mail" } }
        )
      ).result;

    expect({
      held: await select(["connection:MAIL_SEND", long]),
      lowercased: await select(["connection:mail_send", long]),
    }).toStrictEqual({ held: "mailing", lowercased: "no_match" });
  });

  it("is checked as it is saved: a skill resting on itself, or an unknown status, never gets in", async () => {
    const skills = await newCollection(brain, "Skills");

    expect({
      itself: await outcome(
        saved(skills, "refunds", "tasks: [refund]\nprerequisites: [refunds]")
      ),
      status: await outcome(
        saved(skills, "payouts", "tasks: [payout]\nstatus: forced")
      ),
    }).toStrictEqual({
      itself: "knowledge.invalid",
      status: "knowledge.invalid",
    });
  });
});
