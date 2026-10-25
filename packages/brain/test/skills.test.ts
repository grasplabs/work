import { describe, expect, it } from "vite-plus/test";

import type { CollectionRow } from "../src/collections.ts";
import { brainErrors } from "../src/contract.ts";
import type { SkillSelection } from "../src/contract.ts";
import { writeVersion } from "../src/documents.ts";
import { knowledgeErrors } from "../src/knowledge.ts";
import { readSkill, selectSkill, skillsReadMax } from "../src/skills.ts";
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
      "tasks: [close]\nprerequisites: [reconcile]"
    );
    await saved(skills, "report", "tasks: [report]\ndependencies: [ledger@2]");
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

  it("reads only skills: another document, or a version that isn't there, is not found", async () => {
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
    const caller: Caller = { userId: "ann", reads: [skills.id] };

    expect({
      note: await outcome(
        readSkill(brain, caller, { documentId: note.id, version: 1 })
      ),
      later: await outcome(
        readSkill(brain, caller, { documentId: skill.id, version: 2 })
      ),
    }).toStrictEqual({ note: "brain.not_found", later: "brain.not_found" });
  });
});

describe("a skill's manifest", () => {
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
