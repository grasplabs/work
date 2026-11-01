import { brainErrors } from "@grasp-os/brain/contract";
import type { KnowledgeApi } from "@grasp-os/shared/knowledge";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Reader } from "../src/knowledge/access.ts";
import { rerankCandidates } from "../src/knowledge/rerank.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import { signedInApi, unique, whoami } from "./sign-in.ts";

// A recall reranked by the deployment's model (GRA-304; knowledge/
// rerank.ts), through a person's Knowledge RPC and the model gateway,
// whose provider alone is stood in for. What could go wrong, tried here: a
// recall that didn't ask spending a model call; the model's order not
// applied; the call made for no one, off the person's budget, or judged
// as carrying nothing sensitive.

const idp = mockIdp();

const mistral = "mistral/mistral-large-latest";
const euModel = "openai/gpt-5.4";

/** Rules under which only `model` may read sensitive data. */
const sensitiveTo = (model: string) => ({
  sensitive: { models: [model], connections: [] },
});

/** Letters only: digits would make it an identifier, for the exact lane. */
const rareWord = (): string =>
  `zq${[...crypto.getRandomValues(new Uint8Array(14))]
    .map((byte) => String.fromCodePoint(97 + (byte % 26)))
    .join("")}`;

describe("a reranked recall", () => {
  it("orders a person's evidence by the deployment's model only when asked, for them, and records the call", async () => {
    const person = await signedInApi(idp, "admin");
    const knowledge: KnowledgeApi = person.api.knowledge;
    const { id: collectionId } = await knowledge.createCollection({
      name: `Leave ${unique()}`,
      access: "everyone",
    });
    const word = rareWord();
    const notes: [string, string][] = [
      ["a.md", `# ${word} days\nThe ${word} days and ${word} rules.`],
      ["b.md", `# ${word}\nWho approves ${word}.`],
      ["c.md", `# Notes\nA ${word} note.`],
    ];
    for (const [path, text] of notes) {
      // oxlint-disable-next-line no-await-in-loop -- one save at a time
      await knowledge.saveDocument({ collectionId, path, text, ifVersion: 0 });
    }
    const query = `How many ${word} days?`;
    const plain = await knowledge.recall({ query });
    const fusedIds = plain.items.map(({ id }) => id);
    const provider = await answeringProvider(() => ({
      text: JSON.stringify({ ranking: fusedIds.toReversed() }),
      inputTokens: 200,
      outputTokens: 20,
    }));
    await knowledge.recall({ query });
    const unasked = provider.requests.length;
    const reranked = await knowledge.recall({
      query,
      budget: { rerank: true },
    });
    const events = await allEvents();
    const call = events.findLast(
      ({ action, detail }) =>
        action === "model.call" && detail.purpose === "brain.rerank"
    );

    expect({
      unasked,
      asked: provider.requests.length,
      order: reranked.items.map(({ id }) => id),
      policy: reranked.retrievalPolicyVersion,
      call: call && {
        actor: call.actor,
        platform: call.detail.platform,
        provenance: call.provenance,
      },
    }).toStrictEqual({
      unasked: 0,
      asked: 1,
      order: fusedIds.toReversed(),
      policy: "hybrid@1+rerank@1",
      call: {
        actor: { type: "person", userId: person.userId },
        platform: "brain_recall",
        provenance: [collectionId],
      },
    });
  });

  it("is judged as carrying sensitive data under the deployment's rules, and refused where no model may read it", async () => {
    const person = await signedInApi(idp, "user");
    const reader: Reader = {
      type: "person",
      person: await whoami(person.session),
    };
    const request = {
      question: "Who approves leave?",
      candidates: [
        { id: "a", text: "Managers approve leave." },
        { id: "b", text: "HR keeps the leave rules." },
      ],
      provenance: [],
      deadlineMs: 5000,
    };
    await answeringProvider(
      () => ({
        text: JSON.stringify({ ranking: ["b", "a"] }),
        inputTokens: 100,
        outputTokens: 10,
      }),
      { models: [mistral] }
    );
    const ranked = await rerankCandidates(
      { ...env, MODEL_GATEWAY: sensitiveTo(mistral) },
      reader,
      request
    );
    const refused = await rerankCandidates(
      { ...env, MODEL_GATEWAY: sensitiveTo(euModel) },
      reader,
      request
    ).then(
      () => "ok",
      (error: unknown) => brainErrors.codeOf(error)
    );
    const events = await allEvents();
    const call = events.findLast(
      ({ action, actor, detail }) =>
        action === "model.call" &&
        detail.purpose === "brain.rerank" &&
        actor.type === "person" &&
        actor.userId === person.userId
    );

    expect({
      ranked,
      refused,
      sensitive: call?.detail.sensitive,
    }).toStrictEqual({
      ranked: ["b", "a"],
      // No model the organization chose may read sensitive data.
      refused: "brain.unavailable",
      // The company's own words: judged sensitive, as onboarding's are.
      sensitive: "restricted",
    });
  });
});
