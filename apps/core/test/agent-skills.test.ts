import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { installShippedSkills } from "../src/brain-skills.ts";
import { shippedSkills } from "../src/shipped-skills.ts";
import {
  codeResults,
  codeStep,
  personalChatsOf,
  returnedOf,
  says,
} from "./agent-chat.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { signedInWithRole } from "./sign-in.ts";

// Skills for a chat's code (`env.skills.select` / `read`),
// from the Brain (GRA-1826), through the chat as its agent uses them. The
// ways they could fail, tried at core's boundary (the rules' own tests:
// brain-skills.test.ts):
// - an agent with no grant at all gets no skill, though every member's
//   chat may use them, or one with a skill gets more than its text;
// - a selection picks a skill that only seems close, or misses Grasp's
//   own for the task they are for;
// - a release changes the text a task pinned;
// - a call goes unrecorded, or its record carries a skill's text.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** Code that returns what `call` answered, or the message it was refused with. */
const calling = (call: string) =>
  codeStep(
    `export default async (self, env) => { try { return await ${call}; } catch (error) { return error.message; } };`
  );

const selectedSchema = z.object({
  skills: z.array(
    z.object({ scope: z.string(), name: z.string(), version: z.number() })
  ),
});

const readSchema = z.object({ version: z.number(), text: z.string() });

/** The file-an-expense skill as this release ships it. */
const shippedExpense = (): string => {
  const shipped = shippedSkills.find(({ name }) => name === "file-an-expense");
  if (shipped === undefined) {
    throw new Error("The release ships file-an-expense");
  }
  return shipped.text;
};

describe("a chat's skills", setUpTime, () => {
  // Each file starts with empty storage (builtins-first.ts): the
  // release's skills, as its install puts them in.
  beforeAll(async () => {
    await installShippedSkills(env);
  });

  it("selects Grasp's skill for its task with no grant, reads the version it pinned after a release changes it, and records each call without its text", async () => {
    const person = await signedInWithRole(idp, "user");
    const expense = shippedExpense();
    const select = (task: string) =>
      calling(`env.skills.select({ task: ${JSON.stringify(task)} })`);
    const read = (version: number) =>
      calling(
        `env.skills.read({ skill: { scope: "grasp", name: "file-an-expense", version: ${version} } })`
      );
    const { stub, agent, newChat } = await personalChatsOf(
      person.userId,
      select("File the expense for the client lunch"),
      select("Bake a sourdough loaf"),
      read(1_000_000),
      says("Selected.")
    );
    const chat = await newChat();
    await chat.ask("How do I file this expense?");
    const results = await codeResults(stub, chat.chat.id);
    const [forExpense, forBread] = results.map(({ text }) => returnedOf(text));
    const pinned = selectedSchema
      .parse(forExpense)
      .skills.find(({ name }) => name === "file-an-expense");
    if (pinned === undefined) {
      throw new Error("file-an-expense wasn't selected");
    }

    // The next release changes its text: the pin still reads the old.
    await installShippedSkills(env, [
      { name: "file-an-expense", text: `${expense}\nA new step.\n` },
    ]);
    const later = await personalChatsOf(
      person.userId,
      read(pinned.version),
      read(pinned.version + 1),
      says("Read.")
    );
    const again = await later.newChat();
    await again.ask("And now?");
    const laterResults = await codeResults(later.stub, again.chat.id);
    const reads = laterResults.map(({ text }) =>
      readSchema.parse(returnedOf(text))
    );
    // Put back as shipped, for the file's other tests.
    await installShippedSkills(env, [
      { name: "file-an-expense", text: expense },
    ]);

    const calls = await vi.waitFor(
      async () => {
        const events = await allEvents();
        const found = events.filter(
          ({ action, actor, detail }) =>
            action === "agent.call" &&
            actor.type === "agent" &&
            (actor.agentId === agent.agentId ||
              actor.agentId === later.agent.agentId) &&
            typeof detail.method === "string" &&
            detail.method.startsWith("skills.")
        );
        expect(found).toHaveLength(5);
        return found;
      },
      { timeout: 10_000, interval: 50 }
    );

    expect({
      first: selectedSchema.parse(forExpense).skills[0]?.name,
      forBread,
      reads: reads.map(({ version, text }) => ({
        version,
        changed: text.includes("A new step."),
        whole: text.startsWith("---\nname: file-an-expense"),
      })),
      calls: calls.map(({ detail }) => detail.method),
      texts: JSON.stringify(calls).includes("A new step."),
    }).toStrictEqual({
      first: "file-an-expense",
      forBread: { skills: [] },
      reads: [
        { version: pinned.version, changed: false, whole: true },
        { version: pinned.version + 1, changed: true, whole: true },
      ],
      calls: [
        "skills.select",
        "skills.select",
        "skills.read",
        "skills.read",
        "skills.read",
      ],
      texts: false,
    });
    expect(returnedOf(results[2]?.text)).toBe(
      "There's no such skill, or not at that version."
    );
  });
});
