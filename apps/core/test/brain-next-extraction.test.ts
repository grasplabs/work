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
});
