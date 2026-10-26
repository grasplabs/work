import { createBrain } from "@grasp-os/brain/brain";
import { runLinking } from "@grasp-os/brain/entities";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { portsOf } from "../src/knowledge/ports.ts";
import { release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { readCollection } from "./knowledge.ts";
import { finished } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { sampleApp, workflowFiles } from "./workflow-apps.ts";

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

  it("reads what its App's collections say relate an entity, each with its passage, through the same binding", async () => {
    const admin = await signedInApi(idp, "admin");
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
    // Linked as core's linking job does, with the model's answer faked.
    const linking = createBrain(env.KNOWLEDGE, {
      ...portsOf(env),
      extractEntities: async () =>
        await Promise.resolve({
          entities: [
            { kind: "person", name: "Anna" },
            { kind: "process", name: thing },
          ],
          relations: [
            {
              subject: "Anna",
              predicate: "owns",
              object: thing,
              evidence: said,
            },
          ],
        }),
    });
    await runLinking(
      linking,
      { source: `doc:${saved.id}`, version: 1 },
      { do: async (_name, _config, fn) => await fn() }
    );
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
    const [found] = await brain(env.BRAIN).entities.list({ query: ${JSON.stringify(thing)} });
    const relations = await brain(env.BRAIN).relations.get({ entityId: found?.id ?? "-" });
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
});
