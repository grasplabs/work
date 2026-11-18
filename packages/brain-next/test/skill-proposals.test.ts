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
import { runInDurableObject } from "cloudflare:test";
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

/**
 * A tick of this test's person's store, with `ask` as its model and a host
 * that picks `picked` as the sources of any skill's draft.
 */
const tick = async (
  ask: AskModel,
  picked: readonly string[] = [],
  who = person
): Promise<void> => {
  await own(who).work({
    ask,
    at: new Date(),
    embedders: noModel,
    handOvers: noHandOvers,
    contextTokens: null,
    proposalSources: async () => await Promise.resolve([...picked]),
  });
};

/** What drafts here are queued for, in the host's words. */
const subject = "send-report@1";

/** Every row of the store's proposals, their links and its queue that names `source`. */
const naming = async (source: string): Promise<number> =>
  await runInDurableObject(
    own(),
    (_store, state) =>
      state.storage.sql
        .exec<{ count: number }>(
          `SELECT
            (SELECT count(*) FROM skill_proposals WHERE rests_on LIKE ?1)
            + (SELECT count(*) FROM proposal_sources WHERE source = ?2)
            + (SELECT count(*) FROM work_items WHERE payload LIKE ?1)
            AS count`,
          `%${source}%`,
          source
        )
        .one().count
  );

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

/** Queues a draft under `key`, then ticks with `ask`, the host picking `sources`. */
const propose = async (
  key: string,
  sources: string[],
  ask: AskModel
): Promise<void> => {
  await own().proposeSkill({
    person,
    key,
    about: 'Workflow "send-report"',
    subject,
  });
  await tick(ask, sources);
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

  it("queues a draft naming no source, and draws it from what the host picks as it runs: an erased one drafts nothing", async () => {
    const kept = await sourceOf("Workflow run completed.");
    const erased = await sourceOf("Workflow run completed.");
    const key = await keyOf();
    await own().proposeSkill({
      person,
      key,
      about: 'Workflow "send-report"',
      subject,
    });
    const queued = await runInDurableObject(own(), (_store, state) =>
      state.storage.sql
        .exec<{ payload: string }>(
          "SELECT payload FROM work_items WHERE key = ?",
          key
        )
        .toArray()
        .map(({ payload }): unknown => JSON.parse(payload))
    );
    await own().eraseSource({ source: erased, reason: "deleted" });
    const model = draftingModel();
    // The host still picks the erased one: it can't be read.
    await tick(model.ask, [kept, erased]);
    expect({
      queued,
      asked: model.asked.length,
      listed: await own().skillProposals({ reader: readerOf() }),
      naming: await naming(erased),
    }).toStrictEqual({
      queued: [{ key, about: 'Workflow "send-report"', subject }],
      asked: 0,
      listed: [],
      naming: 0,
    });
  });

  it("deletes a proposal and what names its run on that run's erasure, and saves none whose run is erased while it is drawn, nor sends its text once erased while the draft waits its turn", async () => {
    const runs = [
      await sourceOf("Workflow run completed."),
      await sourceOf("Workflow run completed."),
    ];
    const [first = "", second = ""] = runs;
    const third = await sourceOf("Workflow run completed. Third.");
    // One saved, then its first run erased.
    await propose(await keyOf(), runs, draftingModel().ask);
    const [saved] = await own().skillProposals({ reader: readerOf() });
    await own().eraseSource({ source: first, reason: "deleted" });
    // One drawn from the second, which is erased while the model drafts.
    const held = Promise.withResolvers<boolean>();
    const asking = Promise.withResolvers<boolean>();
    const ask: AskModel = async () => {
      asking.resolve(true);
      await held.promise;
      return { kind: "answer", text: drafted, model: "test/model" };
    };
    await own().proposeSkill({
      person,
      key: await keyOf(),
      about: 'Workflow "send-report"',
      subject,
    });
    const ticking = tick(ask, [second]);
    await asking.promise;
    await own().eraseSource({ source: second, reason: "deleted" });
    held.resolve(true);
    await ticking;
    // One drawn from the third, which is erased once it was read, while the
    // draft waits for a turn at the model (the queue's bucket emptied).
    await runInDurableObject(own(), (_store, state) => {
      state.storage.sql.exec(
        `INSERT INTO work_model_bucket (id, tokens, at, paused_until)
        VALUES (1, 0, ?1, 0)
        ON CONFLICT (id) DO UPDATE SET tokens = 0, at = ?1, paused_until = 0`,
        Date.now()
      );
    });
    await own().proposeSkill({
      person,
      key: await keyOf(),
      about: 'Workflow "send-report"',
      subject,
    });
    const picked = Promise.withResolvers<boolean>();
    const waiting = draftingModel();
    const drawing = own().work({
      ask: waiting.ask,
      at: new Date(),
      embedders: noModel,
      handOvers: noHandOvers,
      contextTokens: null,
      proposalSources: async () => {
        picked.resolve(true);
        return await Promise.resolve([third]);
      },
    });
    await picked.promise;
    // Its read is done well before a token comes back (one every 2 s).
    await scheduler.wait(500);
    await own().eraseSource({ source: third, reason: "deleted" });
    await drawing;
    expect({
      saved: saved?.restsOn.map(({ source }) => source),
      askedAfterErasure: waiting.asked.length,
      listed: await own().skillProposals({ reader: readerOf() }),
      kept: await runInDurableObject(
        own(),
        (_store, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM skill_proposals WHERE state = 'open'"
            )
            .one().count
      ),
      naming: [await naming(first), await naming(second), await naming(third)],
    }).toStrictEqual({
      saved: runs,
      askedAfterErasure: 0,
      listed: [],
      kept: 0,
      naming: [0, 0, 0],
    });
  });

  it("drafts from runs as long as a source may be, within what one request to the model may hold", async () => {
    // Each run fills its share of the request: no sentence ends in it, so
    // it is cut by characters.
    const long = "lorem ipsum ".repeat(30_000);
    const sources = [];
    for (let run = 0; run < 5; run += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      sources.push(await sourceOf(long));
    }
    const model = draftingModel();
    await propose(await keyOf(), sources, model.ask);
    const [request] = model.asked;
    const listed = await own().skillProposals({ reader: readerOf() });
    expect({
      asked: model.asked.length,
      within:
        request !== undefined &&
        request.system.length + request.input.length <= 1_000_000,
      listed: listed.length,
    }).toStrictEqual({ asked: 1, within: true, listed: 1 });
  });

  it("treats an answer a person could never add as one that doesn't fit: what it needs is the host's, not a draft's", async () => {
    const model = draftingModel(`---
name: weekly-report
description: When you ask for the weekly report.
requires:
  tools: mail.send
---
Send it.
`);
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
