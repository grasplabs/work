import { runActorOf } from "@grasp-os/shared/audit";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  allAtOnce,
  appWith,
  callFor,
  cheapAnswer,
  countOf,
  dearTotal,
  failedWith,
  llmStep,
  newMonth,
  refusalsOf,
  startChild,
  times,
  withProvider,
} from "./run-lineages.ts";
import { finished } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { workflowFiles } from "./workflow-apps.ts";

// A run lineage's provider requests: 100 a lineage, its root's and its
// children's together, however many ask at once, retries included.
// The helpers it shares with the other run lineage files: run-lineages.ts.

const idp = mockIdp();

describe("run lineages", { timeout: 90_000 }, () => {
  it("count a retried step's requests on top of its lineage's, so its retry can't start the count afresh", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("idle", "  return null;"),
      ...workflowFiles("reader", llmStep("retries: { limit: 2, delay: 1 },"), {
        extract: { total: 1234 },
      }),
    });
    const work = { app, person: builder.userId };
    const root = await builder.api.workflows.start(app, "idle");
    await finished(root.id);
    const rootActor = runActorOf({ runId: root.id, app, workflow: "idle" });

    const result = await withProvider(
      undefined,
      [
        ...times(97, cheapAnswer),
        // Each of the step's attempts sends one request and two retries:
        // its first is refused for the provider's rate each time, and is
        // tried again.
        ...times(3, { status: 429, headers: { "retry-after": "1" } }),
        ...times(6, dearTotal),
      ],
      async (fake) => {
        // The root used 97 of its lineage's 100 requests.
        const before = await allAtOnce(times(97, rootActor), work);
        const child = await startChild(app, "reader", root.id, builder.userId);
        await finished(child);
        return {
          before: countOf(before, "ok"),
          sentByChild: fake.requests.length - 97,
          child: await failedWith(child),
          refused: await refusalsOf(child),
        };
      }
    );

    expect(result).toStrictEqual({
      before: 97,
      sentByChild: 3,
      child: "model.run_limit",
      refused: [["model.run_limit", "requests"]],
    });
  });

  it("admit 100 provider requests a lineage, its root's and its children's together, however many ask at once, and no more", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Lineages" });
    const work = { app, person: builder.userId };
    const root = `run-${crypto.randomUUID()}`;
    const rootActor = runActorOf({ runId: root, app, workflow: "reader" });
    const childActor = runActorOf({
      runId: `run-${crypto.randomUUID()}`,
      app,
      workflow: "reader",
      rootRunId: root,
    });
    const otherLineage = runActorOf({
      runId: `run-${crypto.randomUUID()}`,
      app,
      workflow: "reader",
    });

    const result = await withProvider(
      undefined,
      times(110, cheapAnswer),
      async (fake) => {
        const lineage = await allAtOnce(
          Array.from({ length: 101 }, (_, index) =>
            index % 2 === 0 ? rootActor : childActor
          ),
          work
        );
        return {
          ok: countOf(lineage, "ok"),
          refused: countOf(lineage, "model.run_limit"),
          // In the next month too: a lineage is counted for its whole life.
          again: await callFor(work, childActor, newMonth()),
          other: await callFor(work, otherLineage),
          sent: fake.requests.length,
        };
      }
    );

    expect(result).toStrictEqual({
      ok: 100,
      refused: 1,
      again: "model.run_limit",
      other: "ok",
      sent: 101,
    });
  });
});
