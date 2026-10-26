import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { fakeGateway } from "./ai-gateway.ts";
import { release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { readCollection } from "./knowledge.ts";
import { finished, sleeping, stopped, woken } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { bindModel, sampleApp, workflowFiles } from "./workflow-apps.ts";

// An App's workflow recalling the Brain through its Brain binding,
// `brain(env.BRAIN).recall(…)` (GRA-1067; the threat model is on the
// issue): the same recall as every caller's, as the run, its App on behalf
// of its person, from the collections the App was granted, only while it
// holds the `brain` permission, and recorded with the run. What a run's
// recall does once the run ends or its grant goes mid-run is tested on the
// host, in attempt-fence.test.ts.

const idp = mockIdp();

type Admin = Awaited<ReturnType<typeof signedInApi>>;

/** A word only one test's documents hold. */
const rareWord = (): string =>
  `zq${crypto.randomUUID().replaceAll(/[^a-f]/gu, "")}`;

/** A collection everyone reads, holding `word` in one document. */
const collectionSaying = async (admin: Admin, name: string, word: string) => {
  const { id } = await admin.api.knowledge.createCollection({
    name: `${name} ${crypto.randomUUID()}`,
    access: "everyone",
  });
  await admin.api.knowledge.saveDocument({
    collectionId: id,
    path: "plan.md",
    text: `# Plan\n${word} is the plan.`,
    ifVersion: 0,
  });
  return id;
};

/** `files`, their workflow importing the SDK's `brain` too. */
const withBrain = (files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).map(([path, text]) => [
      path,
      text.replace("import { type Json,", "import { brain, type Json,"),
    ])
  );

/**
 * A workflow that recalls `word` in one step: unfiltered, and filtered to
 * `other`, each answering the collections its evidence cites, or the
 * refusal's code.
 */
const recaller = (word: string, other: string): Record<string, string> =>
  withBrain(
    workflowFiles(
      "recaller",
      `  return await step.do("recall", { description: "Recall the plan" }, async () => {
    const outcome = async (asked: Promise<{ items: { sourceRefs: ({ kind: "document"; collectionId: string } | { kind: "memory" })[] }[] }>) => {
      try {
        const pack = await asked;
        return pack.items.flatMap(({ sourceRefs }) => sourceRefs.flatMap((ref) => (ref.kind === "document" ? [ref.collectionId] : [])));
      } catch (error) {
        return (error as { code?: string }).code ?? String(error);
      }
    };
    return {
      granted: await outcome(brain(env.BRAIN).recall({ query: ${JSON.stringify(word)} })),
      widened: await outcome(brain(env.BRAIN).recall({ query: ${JSON.stringify(word)}, filters: { collectionIds: [${JSON.stringify(other)}] } })),
    } as Json;
  });`,
      { recall: { granted: [], widened: [] } }
    )
  );

/** The App's `brain` permission, under `BRAIN`. */
const brainFor = (app: string): PermissionRequest => ({
  subject: { type: "app", appId: appIdSchema.parse(app) },
  object: { type: "platform" },
  actions: ["brain"],
  binding: "BRAIN",
});

/** A run of the App's `recaller`, once it ended: its status and output. */
const ranOnce = async (admin: Admin, app: string) => {
  const { id } = await admin.api.workflows.start(app, "recaller");
  await finished(id);
  const status = await admin.api.workflows.status(id);
  return {
    id,
    status: status.status,
    output: status.output,
    error: status.error?.name,
  };
};

/** How many recalls the audit log has of run `run`. */
const recallsOf = async (run: string): Promise<number> => {
  const events = await allEvents();
  return events.filter(
    ({ action, detail }) =>
      action === "knowledge.search" &&
      detail.via === "recall" &&
      detail.run === run
  ).length;
};

describe("a workflow's recall through the Brain binding", () => {
  it("recalls as the run from the collections its App was granted, refuses a wider filter, and is recorded with the run", async () => {
    const admin = await signedInApi(idp, "admin");
    const word = rareWord();
    const handbook = await collectionSaying(admin, "Handbook", word);
    const other = await collectionSaying(admin, "Other", word);
    const { id: app } = await admin.api.apps.create({ name: "Recall" });
    const app_ = { type: "app", appId: appIdSchema.parse(app) } as const;
    await requestGranted(idp, admin, readCollection(app_, handbook));
    await requestGranted(idp, admin, brainFor(app));
    // Released once it holds its permissions: its `env.BRAIN` is typed.
    await release(admin, app, { ...sampleApp(), ...recaller(word, other) });

    const run = await ranOnce(admin, app);
    const events = await allEvents();

    expect({
      status: run.status,
      output: run.output,
      recorded: events.some(
        ({ action, detail }) =>
          action === "knowledge.search" &&
          detail.via === "recall" &&
          detail.run === run.id
      ),
    }).toStrictEqual({
      status: "completed",
      // The collection it may read, never the one it wasn't granted.
      output: { granted: [handbook], widened: "brain.not_found" },
      recorded: true,
    });
  });

  it("recalls nothing from a collection whose grant was revoked, and has no Brain binding once its brain permission was", async () => {
    const admin = await signedInApi(idp, "admin");
    const word = rareWord();
    const handbook = await collectionSaying(admin, "Handbook", word);
    const { id: app } = await admin.api.apps.create({ name: "Recall" });
    const app_ = { type: "app", appId: appIdSchema.parse(app) } as const;
    const collectionGrant = await requestGranted(
      idp,
      admin,
      readCollection(app_, handbook)
    );
    const brainGrant = await requestGranted(idp, admin, brainFor(app));
    await release(admin, app, {
      ...sampleApp(),
      ...recaller(word, handbook),
    });

    await admin.api.permissions.revoke(collectionGrant);
    const withoutCollection = await ranOnce(admin, app);
    await admin.api.permissions.revoke(brainGrant);
    const withoutBrain = await ranOnce(admin, app);

    expect({
      withoutCollection: withoutCollection.output,
      withoutBrain: { status: withoutBrain.status, error: withoutBrain.error },
    }).toStrictEqual({
      // Its collection is no longer one it may read: no evidence, and
      // naming it is refused as one that isn't there.
      withoutCollection: { granted: [], widened: "brain.not_found" },
      // A run's env holds a binding only while its permission does: the
      // run that names it fails.
      withoutBrain: { status: "failed", error: "PermissionError" },
    });
  });

  it("keeps a recall's evidence across a crash, never recalling again, and still refuses the next model call once a revoke came in between", async () => {
    const admin = await signedInApi(idp, "admin");
    const word = rareWord();
    const handbook = await collectionSaying(admin, "Handbook", word);
    const { id: app } = await admin.api.apps.create({ name: "Recall" });
    const app_ = { type: "app", appId: appIdSchema.parse(app) } as const;
    const collectionGrant = await requestGranted(
      idp,
      admin,
      readCollection(app_, handbook)
    );
    await requestGranted(idp, admin, brainFor(app));
    await release(admin, app, {
      ...sampleApp({ models: { extractor: 6000 } }),
      ...withBrain(
        workflowFiles(
          "asker",
          `  const recalled = await step.do("recall", { description: "Recall the plan" }, async () => {
    const pack = await brain(env.BRAIN).recall({ query: ${JSON.stringify(word)} });
    return pack.items.length as Json;
  });
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  let asked: Json;
  try {
    const answer = await step.llm("extract", {
      description: "Read the total",
      binding: "extractor",
      instructions: "Read the total in cents.",
      input: "Total 12.34 EUR",
      schema: z.object({ total: z.int() }),
      retries: { limit: 0 },
    });
    asked = answer.total;
  } catch (error) {
    asked = JSON.stringify(error, Object.getOwnPropertyNames(error)).includes("brain.revoked") ? "brain.revoked" : "refused";
  }
  return { recalled, asked } as Json;`,
          { recall: 1, extract: { total: 1234 } }
        )
      ),
    });
    await bindModel(
      app,
      "extractor",
      "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    );
    const gateway = fakeGateway(
      {
        text: JSON.stringify({ total: 1234 }),
        inputTokens: 5,
        outputTokens: 2,
      },
      { text: JSON.stringify({ total: 1234 }), inputTokens: 5, outputTokens: 2 }
    );
    const ai: AiBinding = env.AI;
    const answering = vi
      .spyOn(ai, "fetch")
      .mockImplementation(gateway.binding.fetch);
    /** A run killed while asleep after its recall, then resumed. */
    const crashed = async (between?: () => Promise<void>) => {
      const { id } = await admin.api.workflows.start(app, "asker");
      await sleeping(id, "go");
      await stopped(id);
      await between?.();
      await woken(id);
      await finished(id);
      const status = await admin.api.workflows.status(id);
      return {
        status: status.status,
        output: status.output ?? null,
        revoked:
          JSON.stringify(status.error ?? null).includes("brain.revoked") ||
          JSON.stringify(status.error ?? null).includes(
            "can no longer be read"
          ),
        recalls: await recallsOf(id),
        asked: gateway.requests.length,
      };
    };

    try {
      const kept = await crashed();
      const revoked = await crashed(async () => {
        await admin.api.permissions.revoke(collectionGrant);
      });

      expect({ kept, revoked }).toStrictEqual({
        // Replayed from its record after the crash: one recall, its pack,
        // and the model asked once, as it may still read what it cites.
        kept: {
          status: "completed",
          output: { recalled: 1, asked: 1234 },
          revoked: false,
          recalls: 1,
          asked: 1,
        },
        // The revoke while it was down: the resumed run's replayed recall
        // stands as recorded, its model call is refused before the gateway
        // is asked, and so is its output: the run fails as revoked.
        revoked: {
          status: "failed",
          output: null,
          revoked: true,
          recalls: 1,
          asked: 1,
        },
      });
    } finally {
      answering.mockRestore();
    }
  });

  it("fails as revoked, never with its own message, a run that throws what it recalled once it may no longer read it", async () => {
    const admin = await signedInApi(idp, "admin");
    const word = rareWord();
    const handbook = await collectionSaying(admin, "Handbook", word);
    const { id: app } = await admin.api.apps.create({ name: "Recall" });
    const app_ = { type: "app", appId: appIdSchema.parse(app) } as const;
    const collectionGrant = await requestGranted(
      idp,
      admin,
      readCollection(app_, handbook)
    );
    await requestGranted(idp, admin, brainFor(app));
    await release(admin, app, {
      ...sampleApp(),
      ...withBrain(
        workflowFiles(
          "thrower",
          `  const recalled = await step.do("recall", { description: "Recall the plan" }, async () => {
    const pack = await brain(env.BRAIN).recall({ query: ${JSON.stringify(word)} });
    return pack.items.map(({ statement }) => statement).join(" ") as Json;
  });
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  await step.do("fail", { description: "Fail with it" }, async () => {
    throw new Error(String(recalled));
  });
  return null;`,
          { recall: "", fail: null }
        )
      ),
    });
    /** A run of `thrower`, `between` its recall and its throw. */
    const thrown = async (between?: () => Promise<void>) => {
      const { id } = await admin.api.workflows.start(app, "thrower");
      await sleeping(id, "go");
      await stopped(id);
      await between?.();
      await woken(id);
      await finished(id);
      const { status, error, failure } = await admin.api.workflows.status(id);
      // Its failure report, and the error the engine ended it with.
      const stored = JSON.stringify([failure ?? null, error ?? null]);
      return {
        status,
        code: failure?.error.code ?? null,
        recalledText: stored.includes(word),
      };
    };

    const kept = await thrown();
    const revoked = await thrown(async () => {
      await admin.api.permissions.revoke(collectionGrant);
    });

    expect({ kept, revoked }).toStrictEqual({
      // Still readable: its own error, as it threw it.
      kept: {
        status: "failed",
        code: "workflow.run_failed",
        recalledText: true,
      },
      // Not any more: its error is the refusal, its text nowhere in it.
      revoked: { status: "failed", code: "brain.revoked", recalledText: false },
    });
  });
});
