import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { wordLesson } from "../src/knowledge/lesson-wording.ts";
import { allEvents } from "./audit-events.ts";
import { fakeProviderFor, testModel } from "./model-provider.ts";

// Core's side of a lesson's wording (GRA-301, slice 3; the threat model is
// on the issue): one call through the model gateway, recorded as the
// Brain's upkeep, given what the lesson holds and nothing else.

describe("a lesson's wording", () => {
  it("asks the gateway with the lesson's facts alone, recorded as the Brain's upkeep", async () => {
    const provider = await fakeProviderFor([testModel], {
      text: JSON.stringify({ wording: "Tidying invoices kept failing." }),
      inputTokens: 80,
      outputTokens: 10,
    });
    const facts = {
      taskType: "workflow:invoices/tidy",
      versions: ["app:invoices@3"],
      failures: 3,
      completions: 1,
      evidenceStatus: "contested" as const,
      instruction:
        "workflow:invoices/tidy failed 3 of its last 4 finished runs on app:invoices@3.",
    };

    const wording = await wordLesson(env, facts);
    const sent = JSON.stringify(provider.requests.map(({ body }) => body));
    const events = await allEvents();
    const call = events.findLast(
      ({ action, detail }) =>
        action === "model.call" && detail.purpose === "brain.lessons"
    );

    expect({
      wording,
      // What the model was given: the lesson's facts, as data.
      sent: sent.includes("failed 3 of its last 4 finished runs"),
      platform: call?.detail.platform,
      actor: call?.actor,
    }).toStrictEqual({
      wording: "Tidying invoices kept failing.",
      sent: true,
      platform: "brain_upkeep",
      actor: { type: "system" },
    });
  });
});
