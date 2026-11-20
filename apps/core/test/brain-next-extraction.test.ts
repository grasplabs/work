import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { addSource, workBrain } from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { allEvents } from "./audit-events.ts";
import { answeringProvider } from "./model-provider.ts";
import { noProducers } from "./no-producers.ts";

// Extracting memories as core drives it (GRA-1737; the threat model is on
// the issue): a producer adds a version saying whose words it is, core's
// clock ticks the Brain, and the Brain's two calls go through core's
// model gateway to a faked provider, each recorded with its purpose as
// the Brain's upkeep. The store's own tests hold the rules of what is
// kept (packages/brain-next/test/extraction.test.ts).

/** The Brain's one store, as the test reads what was drawn. */
const store = () => inJurisdiction(env, env.BRAIN_STORE).getByName("brain");

/** The queue's clock across the file: only forward, as core's clock goes. */
const clock = { at: Date.now() };
const tick = async (): Promise<void> => {
  clock.at = Math.max(clock.at + 60_000, Date.now());
  await workBrain(env, new Date(clock.at), noProducers);
};

/** `person`'s own store, as core names it. */
const ownStore = (person: string) =>
  inJurisdiction(env, env.BRAIN_STORE).getByName(`person:${person}`);

/** The answer of a faked provider for extraction: `proposal` to the read, every statement supported to the check. */
const extractionReply = (body: string, proposal: unknown) => ({
  text: body.includes("You check statements")
    ? JSON.stringify({ supported: [0] })
    : JSON.stringify(proposal),
  inputTokens: 50,
  outputTokens: 20,
});

describe("extracting memories through core", () => {
  it("draws a memory through core's gateway in two calls, each recorded with its purpose", async () => {
    const name = `Acme${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const teamId = crypto.randomUUID();
    const text = `Mail from ${name}: we renew the contract next Friday.`;
    const provider = await answeringProvider((requests) => {
      const body = JSON.stringify(requests.at(-1)?.body);
      return {
        text: body.includes("You check statements")
          ? JSON.stringify({ supported: [0] })
          : JSON.stringify({
              entities: [{ key: "c", kind: "customer", names: [name] }],
              memories: [
                {
                  about: "c",
                  attribute: "renewal_date",
                  date: { kind: "weekday", weekday: 5, weeks: 0 },
                  type: "fact",
                  statement: `${name} renews on Friday.`,
                  quote: "we renew the contract next Friday",
                },
              ],
            }),
        inputTokens: 50,
        outputTokens: 20,
      };
    });
    await addSource(env, {
      source: { producer: "upload", id: crypto.randomUUID() },
      change: crypto.randomUUID(),
      text,
      readers: { kind: "team", teamId },
      said: {
        by: { kind: "outside" },
        // Wednesday 11 November 2026, in the organization's time zone.
        at: new Date("2026-11-11T09:00:00Z"),
        priority: "asked",
      },
    });

    await tick();
    const reader = { person: crypto.randomUUID(), groups: [`team:${teamId}`] };
    // One entity, one memory: a first page holds them whole.
    const {
      entities: [entity],
    } = await store().findEntities({ reader, name });
    const { memories } =
      entity === undefined
        ? { memories: [] }
        : await store().readMemories({ entity: entity.id, reader });
    const events = await allEvents();
    const calls = events
      .filter(
        ({ action, detail }) =>
          action === "model.call" &&
          typeof detail.purpose === "string" &&
          detail.purpose.startsWith("brain.extract")
      )
      .map(({ actor, detail }) => ({
        purpose: detail.purpose,
        platform: detail.platform,
        actor,
      }));

    expect({
      calls,
      // Each request held the version's text.
      sent: provider.requests.every(({ body }) =>
        JSON.stringify(body).includes("we renew the contract next Friday")
      ),
      memories: memories.map(({ value, speaker }) => ({ value, speaker })),
    }).toStrictEqual({
      calls: [
        {
          purpose: "brain.extract",
          platform: "brain_upkeep",
          actor: { type: "system" },
        },
        {
          purpose: "brain.extract.check",
          platform: "brain_upkeep",
          actor: { type: "system" },
        },
      ],
      sent: true,
      memories: [{ value: "2026-11-13", speaker: { kind: "outside" } }],
    });
  });

  it("draws from a person's own source when their own store's alarm ticks, for them alone", async () => {
    const name = `Pied${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const person = `person-${crypto.randomUUID()}`;
    await answeringProvider((requests) =>
      extractionReply(JSON.stringify(requests.at(-1)?.body), {
        entities: [{ key: "c", kind: "customer", names: [name] }],
        memories: [
          {
            about: "c",
            attribute: "status",
            value: "active",
            type: "fact",
            statement: `${name} is active.`,
            quote: `${name} is active`,
          },
        ],
      })
    );
    // Only they may read it: core keeps it in their own store.
    await addSource(env, {
      source: { producer: "upload", id: crypto.randomUUID() },
      change: crypto.randomUUID(),
      text: `My notes: ${name} is active.`,
      readers: { kind: "owner", personId: person },
      said: {
        by: { kind: "person", personId: person },
        at: new Date("2026-11-11T09:00:00Z"),
        priority: "upload",
      },
    });
    // The store's own alarm, as set by the add, until it has no more work.
    let ran = 0;
    // oxlint-disable-next-line no-await-in-loop -- one tick after the other
    while (ran < 10 && (await runDurableObjectAlarm(ownStore(person)))) {
      ran += 1;
    }
    const own = { person, groups: [] };
    const {
      entities: [entity],
    } = await ownStore(person).findEntities({ reader: own, name });
    const { memories } =
      entity === undefined
        ? { memories: [] }
        : await ownStore(person).readMemories({
            entity: entity.id,
            reader: own,
          });
    const asSomeoneElse = await ownStore(person)
      .findEntities({ reader: { person: "someone-else", groups: [] }, name })
      .then(
        () => "answered",
        () => "refused"
      );
    const shared = await store().findEntities({
      reader: { person, groups: [] },
      name,
    });

    expect({
      ticked: ran > 0,
      memories: memories.map(({ value, speaker }) => ({ value, speaker })),
      asSomeoneElse,
      inShared: shared.entities.length,
    }).toStrictEqual({
      ticked: true,
      memories: [{ value: "active", speaker: { kind: "internal", person } }],
      asSomeoneElse: "refused",
      inShared: 0,
    });
  });
});
