import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { brainErrors } from "@grasp-os/brain/contract";
import { entitiesFor, settleMs } from "@grasp-os/brain/entities";
import type { KnowledgeApi } from "@grasp-os/shared/knowledge";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Reader } from "../src/knowledge/access.ts";
import { extractEntities } from "../src/knowledge/entities.ts";
import { brainOf } from "../src/knowledge/ports.ts";
import { answeringGateway, fakeGateway } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { runCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi, unique, whoami } from "./sign-in.ts";

// Linking a saved document's entities, in core: the clock's sweep starts
// the linking workflow on the engine, whose extraction goes through the
// model gateway (faked, the one outside provider), and the Brain links
// what it answers. Nobody calls a relationship API.

const idp = mockIdp();

const workersAi = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const euModel = "openai/gpt-5.4";

describe("linking Brain sources in core", () => {
  it("links a saved document's entities through the workflow and the gateway", async () => {
    const person = await signedInApi(idp, "admin");
    const api: KnowledgeApi = person.api.knowledge;
    const reader: Reader = {
      type: "person",
      person: await whoami(person.session),
    };
    const { id: collectionId } = await api.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const name = `Anna ${unique()}`;
    const address = `anna.${unique()}@example.org`;
    await api.saveDocument({
      collectionId,
      path: "onboarding.md",
      text: `# Onboarding\n${name} (${address}) owns it.`,
      ifVersion: 0,
    });
    // Whatever else is waiting to be linked gets
    // an answer naming nothing.
    const gateway = answeringGateway((requests) => ({
      text: JSON.stringify({
        entities: JSON.stringify(requests.at(-1)?.body ?? "").includes(address)
          ? [{ kind: "person", name, identifiers: [address] }]
          : [],
      }),
      inputTokens: 300,
      outputTokens: 40,
    }));
    const ai: AiBinding = env.AI;
    const spy = vi.spyOn(ai, "fetch").mockImplementation(gateway.binding.fetch);
    try {
      const found = await vi.waitFor(
        async () => {
          // Each sweep starts a few runs: as many as it takes.
          await runCron({}, new Date(Date.now() + settleMs + 60_000));
          const entities = await entitiesFor(brainOf(env), reader, {
            query: name,
          });
          if (entities.length === 0) {
            throw new Error("Not linked yet");
          }
          return entities;
        },
        { timeout: 30_000, interval: 200 }
      );

      expect({
        found: found.map(({ kind, label, sources }) => ({
          kind,
          label,
          sources,
        })),
        asked: gateway.requests.filter(({ body }) =>
          JSON.stringify(body).includes(address)
        ).length,
      }).toStrictEqual({
        found: [{ kind: "person", label: name, sources: 1 }],
        asked: 1,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("reads a source only through a model the sensitive-data rule lists, recorded as the Brain's upkeep", async () => {
    const rules = {
      gateway: "grasp-os-test",
      models: [workersAi, euModel],
      sensitive: { models: [euModel], connections: [] },
    };
    const gateway = fakeGateway({
      text: JSON.stringify({ entities: [] }),
      inputTokens: 100,
      outputTokens: 10,
    });
    const marker = `Upkeep ${unique()}`;
    const read = await extractEntities(
      { ...env, AI: gateway.binding, MODEL_GATEWAY: rules },
      `${marker} is a project.`
    );
    // A careful model the rule doesn't list: no model may read it.
    const refused = await extractEntities(
      {
        ...env,
        AI: gateway.binding,
        MODEL_GATEWAY: { ...rules, roles: { careful: workersAi } },
      },
      "Anything."
    ).then(
      () => "ok",
      (error: unknown) => brainErrors.codeOf(error)
    );
    const events = await allEvents();
    const call = events.findLast(
      ({ action, detail }) =>
        action === "model.call" &&
        detail.purpose === "brain.entities" &&
        detail.platform === "brain_upkeep"
    );

    expect({
      read,
      refused,
      sentTo: gateway.requests.map(({ url }) => url.includes("/openai/")),
      call: call && {
        actor: call.actor,
        model: call.model?.model,
        sensitive: call.detail.sensitive,
      },
    }).toStrictEqual({
      read: { entities: [] },
      refused: "brain.unavailable",
      sentTo: [true],
      call: {
        actor: { type: "system" },
        model: "gpt-5.4",
        // Judged as carrying sensitive data, as onboarding's calls are.
        sensitive: "restricted",
      },
    });
  });
});
