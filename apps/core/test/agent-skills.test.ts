import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { installShippedSkills } from "../src/brain-skills.ts";
import { shippedSkills } from "../src/shipped-skills.ts";
import { codeResults, codeStep, personalChatsOf, says } from "./agent-chat.ts";
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

/** What a code step returned, as JSON, or its text when it isn't. */
const returned = (text: string | undefined): unknown => {
  const body = (text ?? "").replace(/^Returned:\n/u, "");
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed;
  } catch {
    return body;
  }
};

const selectedSchema = z.object({
  skills: z.array(
    z.object({ scope: z.string(), name: z.string(), version: z.number() })
  ),
});

const readSchema = z.object({ version: z.number(), text: z.string() });

/** The draw-a-workflow skill as this release ships it. */
const shippedDrawing = (): string => {
  const shipped = shippedSkills.find(({ name }) => name === "draw-a-workflow");
  if (shipped === undefined) {
    throw new Error("The release ships draw-a-workflow");
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
    const drawing = shippedDrawing();
    const select = (task: string) =>
      calling(`env.skills.select({ task: ${JSON.stringify(task)} })`);
    const read = (version: number) =>
      calling(
        `env.skills.read({ skill: { scope: "grasp", name: "draw-a-workflow", version: ${version} } })`
      );
    const { stub, agent, newChat } = await personalChatsOf(
      person.userId,
      select("Draw how invoices are paid as a workflow"),
      select("Bake a sourdough loaf"),
      read(1_000_000),
      says("Selected.")
    );
    const chat = await newChat();
    await chat.ask("How do I draw our invoice workflow?");
    const results = await codeResults(stub, chat.chat.id);
    const [forWorkflow, forBread] = results.map(({ text }) => returned(text));
    const pinned = selectedSchema
      .parse(forWorkflow)
      .skills.find(({ name }) => name === "draw-a-workflow");
    if (pinned === undefined) {
      throw new Error("draw-a-workflow wasn't selected");
    }

    // The next release changes its text: the pin still reads the old.
    await installShippedSkills(env, [
      { name: "draw-a-workflow", text: `${drawing}\nA new step.\n` },
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
      readSchema.parse(returned(text))
    );
    // Put back as shipped, for the file's other tests.
    await installShippedSkills(env, [
      { name: "draw-a-workflow", text: drawing },
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
      first: selectedSchema.parse(forWorkflow).skills[0]?.name,
      forBread,
      reads: reads.map(({ version, text }) => ({
        version,
        changed: text.includes("A new step."),
        whole: text.startsWith("---\nname: draw-a-workflow"),
      })),
      calls: calls.map(({ detail }) => detail.method),
      texts: JSON.stringify(calls).includes("A new step."),
    }).toStrictEqual({
      first: "draw-a-workflow",
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
    expect(returned(results[2]?.text)).toBe(
      "There's no such skill, or not at that version."
    );
  });
});
