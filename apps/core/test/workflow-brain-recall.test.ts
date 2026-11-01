import { createBrain } from "@grasp-os/brain/brain";
import { delegateCitesMax } from "@grasp-os/brain/contract";
import { runLinking } from "@grasp-os/brain/entities";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { appVersions } from "../src/db/core/schema.ts";
import { portsOf } from "../src/knowledge/ports.ts";
import { release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { readCollection } from "./knowledge.ts";
import { fakeProviderFor } from "./model-provider.ts";
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

/**
 * A collection everyone reads, holding `word` in its one document, and
 * who says so, `by`.
 */
const documentSaying = async (
  admin: Admin,
  name: string,
  word: string,
  by = "Ops"
) => {
  const { id } = await admin.api.knowledge.createCollection({
    name: `${name} ${crypto.randomUUID()}`,
    access: "everyone",
  });
  const document = await admin.api.knowledge.saveDocument({
    collectionId: id,
    path: "plan.md",
    text: `# Plan\n${word} is the plan, says ${by}.`,
    ifVersion: 0,
  });
  return { collectionId: id, documentId: document.id };
};

/** A collection everyone reads, holding `word` in one document. */
const collectionSaying = async (admin: Admin, name: string, word: string) => {
  const { collectionId } = await documentSaying(admin, name, word);
  return collectionId;
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

/**
 * A workflow that selects a skill for `type` in one step and reads it at
 * the pin, answering the skill's name and whether its text came, or why
 * none; and selects for `other`, which only a collection it wasn't
 * granted holds.
 */
const selector = (type: string, other: string): Record<string, string> =>
  withBrain(
    workflowFiles(
      "recaller",
      `  return await step.do("skill", { description: "Pick the skill" }, async () => {
    const granted = await brain(env.BRAIN).skills.select({ task: { type: ${JSON.stringify(type)} } });
    const other = await brain(env.BRAIN).skills.select({ task: { type: ${JSON.stringify(other)} } });
    const otherResult = other.result.kind === "none" ? other.result.reason : other.result.skill.name;
    if (granted.result.kind === "none") {
      return { granted: granted.result.reason, other: otherResult } as Json;
    }
    const read = await brain(env.BRAIN).skills.read({ documentId: granted.result.skill.documentId, version: granted.result.skill.version });
    return { granted: [read.skill.name, read.text.includes("Check the order first")], other: otherResult } as Json;
  });`,
      { skill: { granted: [], other: "" } }
    )
  );

/** A collection everyone reads, an admin's, holding a skill for `task`. */
const collectionWithSkill = async (
  admin: Admin,
  name: string,
  task: string
) => {
  const { id } = await admin.api.knowledge.createCollection({
    name: `${name} ${crypto.randomUUID()}`,
    access: "everyone",
  });
  await admin.api.knowledge.saveDocument({
    collectionId: id,
    path: `${task}/SKILL.md`,
    text: `---\nname: ${task}\ndescription: Handles ${task}.\ntasks: [${task}]\nrequires: [platform:brain]\n---\n\n# ${task}\n\nCheck the order first.\n`,
    ifVersion: 0,
  });
  return id;
};

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

/**
 * A handbook everyone reads, saying who owns a process (`thing`) in one
 * document, linked as core's linking job does, the model's answer faked.
 */
const linkedOwners = async (admin: Admin) => {
  const thing = `Onboarding ${crypto.randomUUID().slice(0, 8)}`;
  const said = `Anna owns ${thing}.`;
  const { id: handbook } = await admin.api.knowledge.createCollection({
    name: `Handbook ${crypto.randomUUID()}`,
    access: "everyone",
  });
  const saved = await admin.api.knowledge.saveDocument({
    collectionId: handbook,
    path: "owners.md",
    text: said,
    ifVersion: 0,
  });
  const linking = createBrain(env.KNOWLEDGE, {
    ...portsOf(env),
    extractEntities: async () =>
      await Promise.resolve({
        entities: [
          { kind: "person", name: "Anna" },
          { kind: "process", name: thing },
        ],
        relations: [
          { subject: "Anna", predicate: "owns", object: thing, evidence: said },
        ],
      }),
  });
  await runLinking(
    linking,
    { source: `doc:${saved.id}`, version: 1 },
    { do: async (_name, _config, fn) => await fn() }
  );
  return { handbook, thing, said, documentId: saved.id };
};

/**
 * More owners of one process (`thing`) than a run's read cites, each in a
 * document of its own that also holds `word`, linked as `linkedOwners`.
 */
const manyOwners = async (admin: Admin, word: string) => {
  const thing = `Payroll ${crypto.randomUUID().slice(0, 8)}`;
  const { id: handbook } = await admin.api.knowledge.createCollection({
    name: `Handbook ${crypto.randomUUID()}`,
    access: "everyone",
  });
  const linking = (owner: string, said: string) =>
    createBrain(env.KNOWLEDGE, {
      ...portsOf(env),
      extractEntities: async () =>
        await Promise.resolve({
          entities: [
            { kind: "person", name: owner },
            { kind: "process", name: thing },
          ],
          relations: [
            {
              subject: owner,
              predicate: "owns",
              object: thing,
              evidence: said,
            },
          ],
        }),
    });
  for (let index = 0; index < delegateCitesMax + 5; index += 1) {
    const owner = `Owner ${index}`;
    const said = `${owner} owns ${thing}.`;
    // oxlint-disable-next-line no-await-in-loop -- one document after another
    const saved = await admin.api.knowledge.saveDocument({
      collectionId: handbook,
      path: `owner-${index}.md`,
      text: `# ${word}\n${said}`,
      ifVersion: 0,
    });
    // oxlint-disable-next-line no-await-in-loop -- one document after another
    await runLinking(
      linking(owner, said),
      { source: `doc:${saved.id}`, version: 1 },
      { do: async (_name, _config, fn) => await fn() }
    );
  }
  return { handbook, thing };
};

/**
 * A workflow `id` that reads `read` in one step, sleeps a day, then
 * returns what it read: its output leaves only after the sleep.
 */
const readThenHand = (id: string, read: string): Record<string, string> =>
  withBrain(
    workflowFiles(
      id,
      `  const read = await step.do("read", { description: "Read" }, async () => JSON.stringify(await ${read}) as Json);
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return await step.do("hand", { description: "Hand it over" }, async () => read);`,
      { read: "", hand: "" }
    )
  );

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

  it("selects and reads a skill as the run, only from the collections its App was granted, and records the selection with the run", async () => {
    const admin = await signedInApi(idp, "admin");
    const task = `refund${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const other = `${task}x`;
    const skills = await collectionWithSkill(admin, "Skills", task);
    await collectionWithSkill(admin, "Other skills", other);
    const { id: app } = await admin.api.apps.create({ name: "Skills" });
    const app_ = { type: "app", appId: appIdSchema.parse(app) } as const;
    await requestGranted(idp, admin, readCollection(app_, skills));
    await requestGranted(idp, admin, brainFor(app));
    await release(admin, app, { ...sampleApp(), ...selector(task, other) });

    const run = await ranOnce(admin, app);
    const events = await allEvents();

    expect({
      status: run.status,
      output: run.output,
      recorded: events
        .filter(
          ({ action, detail }) =>
            action === "knowledge.skill.select" && detail.run === run.id
        )
        .map(({ detail }) => detail.result),
    }).toStrictEqual({
      status: "completed",
      // Never the skill in the collection it wasn't granted.
      output: { granted: [task, true], other: "no_match" },
      recorded: ["skill", "none"],
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
    const model = "mistral/mistral-large-latest";
    const provider = await fakeProviderFor(
      [model],
      {
        text: JSON.stringify({ total: 1234 }),
        inputTokens: 5,
        outputTokens: 2,
      },
      { text: JSON.stringify({ total: 1234 }), inputTokens: 5, outputTokens: 2 }
    );
    await bindModel(app, "extractor", model);
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
        asked: provider.requests.length,
      };
    };

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
  });

  it("fails as revoked, never with its own message, a run that throws what it recalled once it may no longer read it, or once it was purged", async () => {
    const admin = await signedInApi(idp, "admin");
    const word = rareWord();
    const by = rareWord();
    const { collectionId: handbook, documentId } = await documentSaying(
      admin,
      "Handbook",
      word,
      by
    );
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
        purgedText: stored.includes(by),
      };
    };

    const kept = await thrown();
    // The document still readable, its ID and collection the same, but who
    // said it purged from it while the run slept.
    const purged = await thrown(async () => {
      const input: PurgeInput = {
        type: "content",
        documentIds: [documentId],
        terms: [by],
        reason: "erasure_request",
      };
      const plan = await admin.api.knowledge.preparePurge(input);
      await admin.api.knowledge.purge(input, plan.token);
    });
    const revoked = await thrown(async () => {
      await admin.api.permissions.revoke(collectionGrant);
    });

    expect({ kept, purged, revoked }).toStrictEqual({
      // Still readable: its own error, as it threw it.
      kept: {
        status: "failed",
        code: "workflow.run_failed",
        recalledText: true,
        purgedText: true,
      },
      // Purged since: the refusal, nothing it recalled in it.
      purged: {
        status: "failed",
        code: "brain.revoked",
        recalledText: false,
        purgedText: false,
      },
      // Not any more: its error is the refusal, its text nowhere in it.
      revoked: {
        status: "failed",
        code: "brain.revoked",
        recalledText: false,
        purgedText: false,
      },
    });
  });

  it("fails as revoked a run caught running a step named with what it recalled, once it may no longer read it", async () => {
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
    /** A workflow that recalls, sleeps, then runs a step named `third`. */
    const naming = (id: string, third: string, named: string) =>
      workflowFiles(
        id,
        `  const recalled = await step.do("recall", { description: "Recall the plan" }, async () => {
    const pack = await brain(env.BRAIN).recall({ query: ${JSON.stringify(word)} });
    return pack.items.map(({ statement }) => statement).join(" ") as Json;
  });
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  await step.do(${third}, { description: "Name it" }, async () => null);
  return null;`,
        { recall: "", [named]: null }
      );
    await release(admin, app, {
      ...sampleApp(),
      ...withBrain({
        ...naming("shown", `"rename"`, "rename"),
        // Named with the recalled word: a step name holds no spaces.
        ...naming(
          "renamer",
          'String(recalled).match(/zq[a-f]+/u)?.[0] ?? "none"',
          "none"
        ),
      }),
    });
    // What the review shows `renamer` running: its first two steps, as
    // `shown` writes them, so its third, named by the run, is tampering.
    const [row] = await drizzle(env.DB)
      .select({ calls: appVersions.workflowCalls })
      .from(appVersions)
      .where(and(eq(appVersions.appId, app), eq(appVersions.version, 1)));
    const stored = row?.calls ?? {};
    const { shown } = stored;
    if (shown?.steps === null || shown === undefined) {
      throw new Error("The review didn't read shown's steps");
    }
    const { rename: _step, ...steps } = shown.steps;
    const { rename: _kind, ...kinds } = shown.kinds;
    await drizzle(env.DB)
      .update(appVersions)
      .set({
        workflowCalls: { ...stored, renamer: { ...shown, steps, kinds } },
      })
      .where(and(eq(appVersions.appId, app), eq(appVersions.version, 1)));

    const { id } = await admin.api.workflows.start(app, "renamer");
    await sleeping(id, "go");
    await stopped(id);
    await admin.api.permissions.revoke(collectionGrant);
    await woken(id);
    await finished(id);
    const { status, error, failure } = await admin.api.workflows.status(id);
    const stored_ = JSON.stringify([failure ?? null, error ?? null]);

    // Refused for its evidence, not for its step: the step's name, made of
    // what it recalled, nowhere in its failure.
    expect({
      status,
      code: failure?.error.code ?? null,
      recalledText: stored_.includes(word),
    }).toStrictEqual({
      status: "failed",
      code: "brain.revoked",
      recalledText: false,
    });
  });

  it("reads what its App's collections say relate an entity, each with its passage, through the same binding", async () => {
    const admin = await signedInApi(idp, "admin");
    const { handbook, thing, said } = await linkedOwners(admin);
    const { id: app } = await admin.api.apps.create({ name: "Relations" });
    const app_ = { type: "app", appId: appIdSchema.parse(app) } as const;
    await requestGranted(idp, admin, readCollection(app_, handbook));
    await requestGranted(idp, admin, brainFor(app));
    await release(admin, app, {
      ...sampleApp(),
      ...withBrain(
        workflowFiles(
          "recaller",
          `  return await step.do("relations", { description: "Who owns it" }, async () => {
    const { entities: [found] } = await brain(env.BRAIN).entities.list({ query: ${JSON.stringify(thing)} });
    const { relations } = await brain(env.BRAIN).relations.get({ entityId: found?.id ?? "-" });
    return relations.map(({ subject, predicate, evidence }) => ({ owner: subject.name, predicate, evidence })) as Json;
  });`,
          { relations: [] }
        )
      ),
    });

    const run = await ranOnce(admin, app);

    expect({ status: run.status, output: run.output }).toStrictEqual({
      status: "completed",
      output: [{ owner: "Anna", predicate: "owns", evidence: said }],
    });
  });

  it("fails as revoked, its output never handed over, a run whose entity read, sources, relations or paths cite what it may no longer read", async () => {
    const admin = await signedInApi(idp, "admin");
    const { handbook, thing, said, documentId } = await linkedOwners(admin);
    const [found] = await admin.api.knowledge.entities({ query: thing });
    const entityId = JSON.stringify(found?.id ?? "-");
    const { id: app } = await admin.api.apps.create({ name: "Relations" });
    const app_ = { type: "app", appId: appIdSchema.parse(app) } as const;
    const collectionGrant = await requestGranted(
      idp,
      admin,
      readCollection(app_, handbook)
    );
    await requestGranted(idp, admin, brainFor(app));
    await release(admin, app, {
      ...sampleApp(),
      ...readThenHand(
        "lister",
        `brain(env.BRAIN).entities.list({ query: ${JSON.stringify(thing)} })`
      ),
      ...readThenHand(
        "sourcer",
        `brain(env.BRAIN).entities.sources({ entityId: ${entityId} })`
      ),
      ...readThenHand(
        "relater",
        `brain(env.BRAIN).relations.get({ entityId: ${entityId} })`
      ),
      ...readThenHand(
        "explainer",
        `brain(env.BRAIN).relations.explain({ entityId: ${entityId} })`
      ),
    });
    /** Runs of each workflow, asleep after their read, then `between`. */
    const ran = async (
      workflows: readonly string[],
      between?: () => Promise<void>
    ) => {
      const ids = await Promise.all(
        workflows.map(async (name) => {
          const { id } = await admin.api.workflows.start(app, name);
          return id;
        })
      );
      await Promise.all(
        ids.map(async (id) => {
          await sleeping(id, "go");
          await stopped(id);
        })
      );
      await between?.();
      const ended = await Promise.all(
        ids.map(async (id) => {
          await woken(id);
          await finished(id);
          const { status, output, failure } =
            await admin.api.workflows.status(id);
          const shown = JSON.stringify([output ?? null, failure ?? null]);
          return {
            status,
            code: failure?.error.code ?? null,
            handed: [thing, said, documentId].some((text) =>
              shown.includes(text)
            ),
          };
        })
      );
      return ended;
    };

    const [kept] = await ran(["relater"]);
    const revoked = await ran(
      ["lister", "sourcer", "relater", "explainer"],
      async () => {
        await admin.api.permissions.revoke(collectionGrant);
      }
    );

    expect({ kept, revoked }).toStrictEqual({
      // Still readable: what it read leaves as its output.
      kept: { status: "completed", code: null, handed: true },
      // Each read pinned what it cites: refused before its output leaves.
      revoked: [
        { status: "failed", code: "brain.revoked", handed: false },
        { status: "failed", code: "brain.revoked", handed: false },
        { status: "failed", code: "brain.revoked", handed: false },
        { status: "failed", code: "brain.revoked", handed: false },
      ],
    });
  });

  it("cites no more than a recall does from each entity or relations read, so a run that makes many still recalls", async () => {
    const admin = await signedInApi(idp, "admin");
    const word = rareWord();
    const { handbook, thing } = await manyOwners(admin, word);
    const { id: app } = await admin.api.apps.create({ name: "Relations" });
    const app_ = { type: "app", appId: appIdSchema.parse(app) } as const;
    await requestGranted(idp, admin, readCollection(app_, handbook));
    await requestGranted(idp, admin, brainFor(app));
    await release(admin, app, {
      ...sampleApp(),
      ...withBrain(
        workflowFiles(
          "recaller",
          `  return await step.do("reads", { description: "Read and recall" }, async () => {
    const reads = [];
    for (let round = 0; round < 3; round += 1) {
      const listed = await brain(env.BRAIN).entities.list({ query: ${JSON.stringify(thing)} });
      const entityId = listed.entities.find(({ label }) => label === ${JSON.stringify(thing)})?.id ?? "-";
      const sources = await brain(env.BRAIN).entities.sources({ entityId });
      const owners = await brain(env.BRAIN).relations.get({ entityId });
      const paths = await brain(env.BRAIN).relations.explain({ entityId, hops: 1, budget: { maxPaths: 50 } });
      reads.push([listed.truncated, sources.sources.length, sources.truncated, owners.relations.length, owners.truncated, paths.paths.length, paths.truncated]);
    }
    const pack = await brain(env.BRAIN).recall({ query: ${JSON.stringify(word)} });
    return { reads, recalled: pack.items.length > 0 } as Json;
  });`,
          { reads: { reads: [], recalled: false } }
        )
      ),
    });

    const run = await ranOnce(admin, app);

    const cut = [
      true,
      delegateCitesMax,
      true,
      delegateCitesMax,
      true,
      delegateCitesMax,
      true,
    ];
    expect({ status: run.status, output: run.output }).toStrictEqual({
      status: "completed",
      // Each read cut to what it pins, and said so; the recall after them
      // all still fits the run's evidence.
      output: { reads: [cut, cut, cut], recalled: true },
    });
  });
});
