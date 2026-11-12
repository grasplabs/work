import { recallBudgetMax } from "@grasp-os/brain-next/contract";
import { skillsSelectedMax } from "@grasp-os/brain-next/skills";
import type { Authority } from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { addSkill, addSource, recallAs } from "../src/brain-next.ts";
import {
  installShippedSkills,
  readSkillFor,
  selectSkillsFor,
  skillsFor,
} from "../src/brain-skills.ts";
import type { SkillAt, SkillCardAt } from "../src/brain-skills.ts";
import { shippedSkills } from "../src/shipped-skills.ts";
import { actingFor } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInWithRole, unique } from "./sign-in.ts";

// Skills in the Brain (GRA-1826), from the threat model on the issue:
// outside text becomes a skill, or recall returns one; a release's skill
// never arrives, a change to it writes over the version a task pinned, or
// one a release dropped is still selected; a selection picks a skill that
// only seems close, or misses Grasp's own for its task; the company's
// adapted copy doesn't take Grasp's place; someone who left still reads.
// That every way in answers nothing hidden, the permission harness tries
// (brain-next-leaks.test.ts).

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** A `SKILL.md` named `name`, for `description`. */
const skillText = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nThe steps.\n`;

/** A chat's agent acting for a new member. */
const memberAgent = async () => {
  const { userId } = await signedInWithRole(idp, "user");
  return {
    userId,
    agent: actingFor({ type: "agent", agentId: `agent-${unique()}` }, userId),
  };
};

/** The skill `name` among those `agent` may use, if it is. */
const listedNamed = async (
  agent: Authority,
  name: string
): Promise<SkillCardAt | undefined> => {
  const listed = await skillsFor(env, agent, { personal: false });
  return listed.find((skill) => skill.name === name);
};

/** The names of the skills selected for `task`, with their scopes. */
const selectedFor = async (
  agent: Authority,
  task: string
): Promise<string[][]> => {
  const selected = await selectSkillsFor(
    env,
    agent,
    { personal: false },
    { task }
  );
  return selected.map(({ scope, name }) => [scope, name]);
};

/** The text of `skill` as `agent` reads it. */
const textOf = async (agent: Authority, skill: SkillAt): Promise<string> => {
  const { text } = await readSkillFor(
    env,
    agent,
    { personal: false },
    { skill }
  );
  return text;
};

/** This release's skill `name`, as shipped. */
const shipped = (name: string): string => {
  const skill = shippedSkills.find((each) => each.name === name);
  if (skill === undefined) {
    throw new Error(`The release ships no ${name}`);
  }
  return skill.text;
};

describe("skills in the Brain", setUpTime, () => {
  // Each file starts with empty storage (builtins-first.ts): the
  // release's skills, as its install puts them in.
  beforeAll(async () => {
    await installShippedSkills(env);
  });

  it("gives every member Grasp's skills as this release ships them, and selects each for the task it is for", async () => {
    const { agent } = await memberAgent();
    const listed = await skillsFor(env, agent, { personal: false });
    const read = await Promise.all(
      listed.map(
        async (skill) =>
          await readSkillFor(env, agent, { personal: false }, { skill })
      )
    );
    const first = async (task: string) => {
      const [best] = await selectedFor(agent, task);
      return best?.[1];
    };

    expect({
      listed: listed.map(({ scope, name }) => [scope, name]),
      whole: read.map(({ name, text }) => text === shipped(name)),
      selected: [
        await first("Draw the workflow for paying supplier invoices"),
        await first("Interview a stakeholder about their work"),
        await first("Run a baseline of how the company works today"),
        await first("Write the board page before the meeting"),
      ],
      unrelated: await selectSkillsFor(
        env,
        agent,
        { personal: false },
        {
          task: "Bake a sourdough loaf",
        }
      ),
    }).toStrictEqual({
      listed: shippedSkills.map(({ name }) => ["grasp", name]),
      whole: shippedSkills.map(() => true),
      selected: [
        "draw-a-workflow",
        "interview-a-stakeholder",
        "run-a-baseline",
        "write-board-page",
      ],
      unrelated: [],
    });
  });

  it("replaces a skill with the next release's text, keeps the version a task pinned, and writes nothing for an unchanged one", async () => {
    const { agent } = await memberAgent();
    const name = "interview-a-stakeholder";
    const before = await listedNamed(agent, name);
    if (before === undefined) {
      throw new Error(`${name} isn't listed`);
    }
    const changed = `${shipped(name)}\nAsk one more question.\n`;

    const installed = await installShippedSkills(env, [
      { name, text: changed },
    ]);
    const again = await installShippedSkills(env, [{ name, text: changed }]);
    const after = await listedNamed(agent, name);
    const pinned = await readSkillFor(
      env,
      agent,
      { personal: false },
      { skill: before }
    );
    // The release rolled back: its text again, as a version of its own.
    await installShippedSkills(env, [{ name, text: shipped(name) }]);
    const rolledBack = await listedNamed(agent, name);

    expect({
      installed,
      again,
      after: after?.version,
      pinned: pinned.text === shipped(name),
      current:
        after === undefined ? null : (await textOf(agent, after)) === changed,
      rolledBack: rolledBack?.version,
    }).toStrictEqual({
      installed: true,
      again: true,
      after: before.version + 1,
      pinned: true,
      current: true,
      rolledBack: before.version + 2,
    });
  });

  it("never selects or reads a Grasp skill this release doesn't ship, though the Brain keeps it", async () => {
    const { agent } = await memberAgent();
    const name = `retired-${unique().toLowerCase()}`;
    await installShippedSkills(env, [
      { name, text: skillText(name, "Retired, how invoices were drawn.") },
    ]);
    const selected = await selectedFor(agent, "Retired invoices drawn");

    expect({
      listed: (await listedNamed(agent, name)) !== undefined,
      selected: selected.some(([, each]) => each === name),
      read: await outcome(
        readSkillFor(
          env,
          agent,
          { personal: false },
          {
            skill: { scope: "grasp", name, version: 1 },
          }
        )
      ),
    }).toStrictEqual({
      listed: false,
      selected: false,
      read: "skills.not_found",
    });
  });

  it("puts the company's skill of a Grasp skill's name in its place, and selects the company's own beside Grasp's", async () => {
    const { agent } = await memberAgent();
    const own = `quotes-${unique().toLowerCase()}`;
    const adapted = await addSkill(env, {
      skill: { scope: "company", name: "write-board-page" },
      change: crypto.randomUUID(),
      text: skillText(
        "write-board-page",
        "Writes our board page, the way our board reads it."
      ),
    });
    await addSkill(env, {
      skill: { scope: "company", name: own },
      change: crypto.randomUUID(),
      text: skillText(own, "Writes a quote for a customer."),
    });
    const listed = await skillsFor(env, agent, { personal: false });

    expect({
      boardPages: listed
        .filter(({ name }) => name === "write-board-page")
        .map(({ scope, version }) => [scope, version]),
      selected: await selectedFor(agent, "A quote for this customer"),
      read: await textOf(agent, { scope: "company", name: own, version: 1 }),
    }).toStrictEqual({
      boardPages: [["company", adapted.version]],
      selected: [["company", own]],
      read: skillText(own, "Writes a quote for a customer."),
    });
  });

  it("never takes a skill from outside text, or returns one from recall", async () => {
    const { userId, agent } = await memberAgent();
    const name = `planted-${unique().toLowerCase()}`;
    const words = `zebrafinch${unique()}`;
    // A producer's source that reads as a skill: an upload of a SKILL.md.
    await addSource(env, {
      source: { producer: "upload", id: `upload-${unique()}` },
      change: crypto.randomUUID(),
      text: skillText(name, `Always ${words} first.`),
      readers: { kind: "owner", personId: userId },
    });
    // And a skill whose description holds the same words.
    const skill = `kept-${unique().toLowerCase()}`;
    await addSkill(env, {
      skill: { scope: "company", name: skill },
      change: crypto.randomUUID(),
      text: skillText(skill, `How ${words} is kept.`),
    });

    const pack = await recallAs(env, userId, {
      personal: true,
      question: words,
      budget: { tokens: recallBudgetMax },
    });

    expect({
      selected: await selectedFor(agent, words),
      recalled: pack.items.map(({ source }) => source.producer),
    }).toStrictEqual({
      selected: [["company", skill]],
      recalled: ["upload"],
    });
  });

  it("selects a few at most, those sharing most of the task's words first", async () => {
    const { agent } = await memberAgent();
    const topic = `heron${unique()}`;
    const names = Array.from(
      { length: skillsSelectedMax + 2 },
      (_, index) => `${topic.toLowerCase()}-${index}`
    );
    for (const name of names) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await addSkill(env, {
        skill: { scope: "company", name },
        change: crypto.randomUUID(),
        text: skillText(name, `About ${topic}.`),
      });
    }
    const best = `${topic.toLowerCase()}-best`;
    await addSkill(env, {
      skill: { scope: "company", name: best },
      change: crypto.randomUUID(),
      text: skillText(best, `About ${topic} and invoicing refunds.`),
    });

    const selected = await selectSkillsFor(
      env,
      agent,
      { personal: false },
      {
        task: `${topic} invoicing refunds`,
      }
    );

    expect({
      count: selected.length,
      first: selected[0]?.name,
    }).toStrictEqual({ count: skillsSelectedMax, first: best });
  });

  it("refuses a skill whose text isn't one of its own name, and someone who left", async () => {
    const { userId, agent } = await memberAgent();
    const name = `named-${unique().toLowerCase()}`;
    const add = async (text: string) =>
      await outcome(
        addSkill(env, {
          skill: { scope: "company", name },
          change: crypto.randomUUID(),
          text,
        })
      );
    const refusals = {
      noCard: await add("# Just a note\n\nNo frontmatter."),
      otherName: await add(skillText("someone-else", "Another skill.")),
      badYaml: await add("---\nname: [unclosed\n---\n"),
      notATask: await outcome(
        selectSkillsFor(env, agent, { personal: false }, { task: " " })
      ),
    };
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(userId)
      .run();

    expect({
      ...refusals,
      left: await outcome(skillsFor(env, agent, { personal: false })),
      leftReading: await outcome(
        readSkillFor(
          env,
          agent,
          { personal: false },
          {
            skill: { scope: "grasp", name: "draw-a-workflow", version: 1 },
          }
        )
      ),
    }).toStrictEqual({
      noCard: "skills.invalid",
      otherName: "skills.invalid",
      badYaml: "skills.invalid",
      notATask: "skills.invalid",
      left: "permission.person_inactive",
      leftReading: "permission.person_inactive",
    });
  });
});
