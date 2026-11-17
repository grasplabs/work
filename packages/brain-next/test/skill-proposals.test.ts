// Skill proposals in a person's own store (skill-proposals.ts, GRA-1756;
// the design is on the issue): a draft written by the host's model from
// sources of theirs, once per key, listed to them alone while every
// version it rests on is still current and theirs. Each test has a person
// of its own.
import type {
  AskModel,
  Embedders,
  HandOvers,
  ModelRequest,
  PersonReader,
} from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { BrainStore } from "../src/store.ts";

/** A store, as its namespace gives it. */
type Store = DurableObjectStub<BrainStore>;

let person = "";
const own = (who = person): Store => env.BRAIN_STORE.getByName(`person:${who}`);
const readerOf = (who = person): PersonReader => ({ person: who, groups: [] });

const noModel: Embedders = {
  model: null,
  embed: async () => {
    await Promise.resolve();
    return { kind: "unavailable" };
  },
};

const noHandOvers: HandOvers = {
  handOver: async () => {
    await Promise.resolve();
    return { kind: "nothing" };
  },
};

/** The draft every call answers. */
const drafted = `---
name: weekly-report
description: When you ask for the weekly report.
---
Ask which week, then send it.
`;

/** A model that drafts `answer`, and what it was asked. */
const draftingModel = (answer = drafted) => {
  const asked: ModelRequest[] = [];
  const ask: AskModel = async (request) => {
    asked.push(request);
    await Promise.resolve();
    return { kind: "answer", text: answer, model: "test/model" };
  };
  return { ask, asked };
};

/** A tick of this test's person's store, with `ask` as its model. */
const tick = async (ask: AskModel, who = person): Promise<void> => {
  await own(who).work({
    ask,
    at: new Date(),
    embedders: noModel,
    handOvers: noHandOvers,
    contextTokens: null,
  });
};

/** A source of `who`'s own holding `text`: its key. */
const sourceOf = async (text: string, who = person): Promise<string> => {
  const source = `run:${crypto.randomUUID()}`;
  await own(who).addSource({
    source,
    change: "1",
    text,
    access: { kind: "owner", person: who },
  });
  return source;
};

/** A proposal's key: a SHA-256, as hex. */
const keyOf = async (): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(crypto.randomUUID())
      )
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** Proposes from `sources` under `key`, then ticks with `ask`. */
const propose = async (
  key: string,
  sources: string[],
  ask: AskModel
): Promise<void> => {
  await own().proposeSkill({
    person,
    key,
    about: 'Workflow "send-report"',
    sources,
  });
  await tick(ask);
};

describe("skill proposals", () => {
  beforeEach(() => {
    person = `person-${crypto.randomUUID()}`;
  });

  it("drafts once per key from what its person reads, and lists it to them alone", async () => {
    const sources = [
      await sourceOf("Workflow run completed.\n\nSent the report for week 45."),
      await sourceOf("Workflow run completed.\n\nSent the report for week 46."),
    ];
    const key = await keyOf();
    const model = draftingModel();
    await propose(key, sources, model.ask);
    // The same key again, after a newer run: nothing more is asked.
    await propose(key, sources, model.ask);
    const listed = await own().skillProposals({ reader: readerOf() });
    const stranger = `stranger-${crypto.randomUUID()}`;
    expect({
      asked: model.asked.map(({ purpose, input }) => ({
        purpose,
        week45: input.includes("week 45"),
        week46: input.includes("week 46"),
      })),
      listed: listed.map(({ key: listedKey, text, restsOn }) => ({
        key: listedKey,
        text,
        restsOn: restsOn.map(({ source }) => source),
      })),
      shared: await env.BRAIN_STORE.getByName("brain").skillProposals({
        reader: readerOf(),
      }),
      asSomeoneElse: await own()
        .skillProposals({ reader: readerOf(stranger) })
        .then(
          () => "answered",
          () => "refused"
        ),
    }).toStrictEqual({
      asked: [{ purpose: "brain.skill.propose", week45: true, week46: true }],
      listed: [{ key, text: drafted, restsOn: sources }],
      shared: [],
      asSomeoneElse: "refused",
    });
  });

  it("drafts nothing from a source its person can't read now, and asks no model", async () => {
    const kept = await sourceOf("Workflow run completed.");
    const removed = await sourceOf("Workflow run completed.");
    await own().removeSources({ sources: [removed] });
    const model = draftingModel();
    await propose(await keyOf(), [kept, removed], model.ask);
    await propose(
      await keyOf(),
      [kept, `run:${crypto.randomUUID()}`],
      model.ask
    );
    expect({
      asked: model.asked.length,
      listed: await own().skillProposals({ reader: readerOf() }),
    }).toStrictEqual({ asked: 0, listed: [] });
  });

  it("lists a proposal only while every version it rests on is current, and keeps only its key once settled", async () => {
    const model = draftingModel();
    const first = [
      await sourceOf("Workflow run completed."),
      await sourceOf("Workflow run completed."),
    ];
    const second = [await sourceOf("Workflow run completed.")];
    const third = [await sourceOf("Workflow run completed.")];
    const [out, accepted, dismissed] = [
      await keyOf(),
      await keyOf(),
      await keyOf(),
    ];
    await propose(out, first, model.ask);
    await propose(accepted, second, model.ask);
    await propose(dismissed, third, model.ask);
    // Taken out of use: what it rests on is no longer theirs to read.
    await own().removeSources({ sources: [first[1] ?? ""] });
    await own().settleSkillProposal({
      person,
      key: accepted,
    });
    await own().settleSkillProposal({
      person,
      key: dismissed,
    });
    // Settled keys are never drafted again.
    await propose(accepted, second, model.ask);
    await propose(dismissed, third, model.ask);
    expect({
      listed: await own().skillProposals({ reader: readerOf() }),
      asked: model.asked.length,
    }).toStrictEqual({ listed: [], asked: 3 });
  });

  it("refuses an answer that isn't a skill, and writes nothing", async () => {
    const model = draftingModel("Here is a skill: send the report weekly.");
    await propose(
      await keyOf(),
      [await sourceOf("Workflow run completed.")],
      model.ask
    );
    expect({
      asked: model.asked.length,
      listed: await own().skillProposals({ reader: readerOf() }),
    }).toStrictEqual({ asked: 1, listed: [] });
  });
});
