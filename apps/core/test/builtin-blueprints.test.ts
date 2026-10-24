import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { workflowIdOf } from "@grasp-os/compiler";
import {
  checkWorkflowBindings,
  describeWorkflow,
} from "@grasp-os/sdk/describe";
import { collectionIdSchema, appIdSchema } from "@grasp-os/shared/ids";
import type { CollectionId } from "@grasp-os/shared/ids";
import type {
  DeclaredPermission,
  Authority,
} from "@grasp-os/shared/permissions";
import { quotaLimitsSchema } from "@grasp-os/shared/quota-policy";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import type { BuiltinBlueprint } from "#blueprints";

import {
  createFromBlueprint,
  installBuiltinBlueprint,
} from "../src/app-blueprints.ts";
import { startAppBinding } from "../src/app-workflow-bindings.ts";
import {
  builtins,
  fingerprintOf,
  installBuiltins,
  release,
} from "../src/builtins.ts";
import type { Release } from "../src/builtins.ts";
import { withDraftReferences } from "../src/draft-references.ts";
import { buildScreens } from "../src/screens.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { grantReviewed, racingDb, serverBuilt } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, storedGrant } from "./knowledge.ts";
import { calledAs } from "./sealed-apps.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// The built-in blueprints: blueprints that ship with each release,
// installed on the first request (src/builtins.ts) as blueprints like any
// other (src/app-blueprints.ts). These tests start from the ways that can
// fail: a built-in isn't listed, or can't be created from, as any
// blueprint is; it leaves an App behind that anyone finds, changes, runs,
// shares or asks permissions for; anyone, an admin too, unmarks it; a
// changed release doesn't reach it, is recorded twice when two installs
// race, or changes an App already created from it; an unchanged release
// writes again; a failure halfway is recorded as done; someone who builds
// can't find or copy it, or a user can; a copy doesn't ask for what the
// release declares, or keeps asking once it no longer does; and a
// built-in the release ships doesn't build.
//
// The global setup embeds the tests' own built-in, `hello`
// (test/fixtures/blueprints/), with the release's. The tests of a file
// share their storage, so each test that changes the built-in starts from
// the release, installed again, and ends by installing it again.

const idp = mockIdp();

const hello = (): BuiltinBlueprint => {
  const found = release.blueprints.find(({ id }) => id === "hello");
  if (!found) {
    throw new Error("The global setup didn't embed the tests' built-in");
  }
  return found;
};

/** The singleton's install, asked for by an isolate of this release. */
const ensureInstalled = async (): Promise<boolean> =>
  await builtins(env).ensureInstalled(await fingerprintOf(release));

/** This release, with `hello` changed as `change` says: another release. */
const releaseWith = (change: Partial<BuiltinBlueprint>): Release => ({
  ...release,
  blueprints: release.blueprints.map((blueprint) =>
    blueprint.id === "hello" ? { ...blueprint, ...change } : blueprint
  ),
});

/** Where `hello` keeps its greeting, a function of its release. */
const greetings = "operations/greetings.ts";

/** A release whose `hello` greets differently. */
const changedHello = (): Release =>
  releaseWith({
    files: {
      ...hello().files,
      [greetings]: `${hello().files[greetings]}\n// Changed.\n`,
    },
  });

/** Installs `of` as the singleton would, whatever it installed before. */
const install = async (of: Release, coreEnv: Env = env): Promise<boolean> =>
  await runInDurableObject(builtins(env), async (_instance, state) => {
    await state.storage.delete("installed");
    return await installBuiltins(coreEnv, state.storage, of);
  });

/** The release's built-ins, installed again. */
const reinstall = async (): Promise<void> => {
  await expect(install(release)).resolves.toBeTruthy();
};

/** `hello` as stored. */
const helloRow = async () =>
  await env.DB.prepare(
    "SELECT name, description, tree, permissions FROM blueprints WHERE id = 'hello'"
  ).first<{
    name: string;
    description: string;
    tree: string;
    permissions: string;
  }>();

/** The actions of the audit events of `hello` in `events`. */
const helloActions = (
  events: { action: string; target?: { id: string } }[]
): string[] =>
  events
    .filter(({ target }) => target?.id === "hello")
    .map(({ action }) => action);

/** A permission to read the collection `collectionId`. */
const notesOf = (collectionId: CollectionId): DeclaredPermission => ({
  object: { type: "collection", collectionId },
  actions: ["read"],
  binding: "NOTES",
});

/**
 * A permission to invite guests: one that changes things, so a version no
 * admin approved is asked for it again.
 */
const guests: DeclaredPermission = {
  object: { type: "platform" },
  actions: ["guests"],
  binding: "GUESTS",
};

/** Where `hello`'s screen goes, in a release that ships one. */
const helloScreen = "screens/hello.tsx";

/**
 * A release whose `hello` has a screen: one that calls its App, so it
 * builds in the references each copy's own IDs make (`#grasp`).
 */
const helloWithScreen = (): Release =>
  releaseWith({
    files: {
      ...hello().files,
      [helloScreen]: `import { useMutation } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { api } from "#grasp";

export default function Hello() {
  const greet = useMutation(api.greetings.hello);
  return <Button onClick={() => void greet({ name: "you" })}>Greet</Button>;
}
`,
    },
  });

/** A model the deployment allows. */
const allowedModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** A JSON Schema of an object of `properties`, all required. */
const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/**
 * A workflow a release ships with `hello`, named `name`: a model, bound
 * as `model` to the catalog's `contract`, greets its input's `who`.
 */
const greeter = (contract: string, name = "greeter"): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: "Greeter",
      metadata: {
        grasp: {
          profile: "grasp-open-workflow/1",
          params: {},
          bindings: { model: { kind: "model", contract } },
        },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ line: { type: "string" } }) },
    do: [
      {
        greet: {
          call: "grasp.model",
          with: {
            binding: "model",
            instructions: "Greet them.",
            // oxlint-disable-next-line no-template-curly-in-string -- a workflow expression
            input: { who: "${ $workflow.input.who }" },
            outputSchema: objectSchema({ line: { type: "string" } }),
          },
          // oxlint-disable-next-line no-template-curly-in-string -- a workflow expression
          export: { as: "${ {line: .line} }" },
        },
      },
      // oxlint-disable-next-line no-template-curly-in-string -- a workflow expression
      { finish: { set: { line: "${ $context.line }" } } },
    ],
  });

/** A release whose `hello` ships `greeter` as `greet`, binding `contract`. */
const shippingGreeter = (contract: string, definition = greeter(contract)) =>
  releaseWith({
    contracts: [{ key: contract, kind: "model" }],
    workflows: [{ alias: "greet", binding: "GREET", definition }],
  });

/** An App's authority, for the person `by`, on its first version. */
const authorityOf = (app: string, by: string): Authority => ({
  subject: { type: "app", appId: appIdSchema.parse(app) },
  onBehalfOf: by,
  mode: "interactive",
  appVersion: 1,
});

/** The trees stored for `hello`, by their hashes. */
const helloTrees = async (): Promise<string[]> => {
  const { objects } = await env.FILES.list({
    prefix: "blueprints/hello/trees/",
  });
  return objects
    .map(({ key }) => key.replace(/^.*\//u, "").replace(/\.json$/u, ""))
    .toSorted((one, other) => one.localeCompare(other));
};

/** `files`, where every delete fails. */
const refusingDeletes = (files: R2Bucket): R2Bucket =>
  new Proxy(files, {
    get: (target, key) => {
      if (key === "delete") {
        return async () => {
          await Promise.resolve();
          throw new Error("R2 unavailable");
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });

const writesBlueprint = /^update "blueprints"/iu;

/** `racingDb`, racing the batch that changes a blueprint. */
const dbRacing = (first: () => Promise<unknown>): D1Database =>
  racingDb(first, writesBlueprint);

describe("the built-in blueprints", () => {
  it("are every folder under apps/core/blueprints, and the tests' own", () => {
    // Vite lists the folders at build time; the build embeds each one.
    const folders = Object.keys(
      import.meta.glob("../blueprints/*/blueprint.json")
    ).map((file) => file.split("/")[2] ?? file);
    expect(release.blueprints.map(({ id }) => id).toSorted()).toStrictEqual(
      [...folders, "hello"].toSorted()
    );
  });

  it("are blueprints that everyone who builds finds and creates from, and users don't", async () => {
    await expect(ensureInstalled()).resolves.toBeTruthy();
    const builder = await signedInApi(idp, "builder");
    const user = await signedInApi(idp, "user");

    // Shared with nobody, and found by every builder all the same.
    const listed = await builder.api.apps.blueprints.list();
    expect(listed.find(({ id }) => id === "hello")).toMatchObject({
      id: "hello",
      name: hello().name,
      description: hello().description,
      app: null,
      version: null,
      markedBy: null,
      permissions: [],
    });

    const created = await builder.api.apps.blueprints.create("hello", {
      name: "Our hello",
    });
    await builder.api.apps.versions.setCurrent(created.app.id, 1);
    expect({
      blueprint: created.app.blueprint,
      owner: created.app.owner,
      permissions: created.permissions,
      files: await builder.api.apps.files.read(created.app.id, 1),
      greeting: await calledAs(
        await builder.api.whoami(),
        created.app.id,
        { contractId: "greetings.hello", kind: "mutation" },
        { name: "Ann" }
      ),
    }).toStrictEqual({
      blueprint: "hello",
      owner: builder.userId,
      permissions: [],
      files: hello().files,
      greeting: { ok: true, value: "Hello, Ann: greeting 1" },
    });

    // Users build no Apps: they neither find a built-in nor create from one.
    const theirs = await user.api.apps.blueprints.list();
    expect({
      found: theirs.some(({ id }) => id === "hello"),
      create: await outcome(
        user.api.apps.blueprints.create("hello", { name: "Mine" })
      ),
    }).toStrictEqual({ found: false, create: "role.forbidden" });
  });

  it("leave no App behind, and can't be unmarked, by an admin neither", async () => {
    await expect(ensureInstalled()).resolves.toBeTruthy();
    const admin = await signedInApi(idp, "admin");
    const before = await helloRow();
    const caller = await admin.api.apps.create({ name: `Caller ${unique()}` });
    const listed = await admin.api.apps.list();

    expect({
      // No App for anyone to change, run, share or ask permissions for.
      apps: listed.filter(({ owner }) => owner === "grasp"),
      unmark: await outcome(admin.api.apps.blueprints.unmark("hello")),
      calls: await outcome(
        admin.api.permissions.request({
          subject: { type: "app", appId: caller.id },
          object: { type: "app", appId: "hello" },
          actions: ["read"],
          binding: "HELLO",
        })
      ),
      after: await helloRow(),
    }).toStrictEqual({
      apps: [],
      // Only the release changes it.
      unmark: "role.forbidden",
      // There's no App of it to call.
      calls: "app.not_found",
      after: before,
    });
  });

  it("each create an App that builds", async () => {
    await expect(ensureInstalled()).resolves.toBeTruthy();
    const builder = await signedInApi(idp, "builder");
    for (const blueprint of release.blueprints) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time, as the install does
      const created = await builder.api.apps.blueprints.create(blueprint.id, {
        name: blueprint.name,
      });
      // Its workflows' tests run as it becomes current.
      // oxlint-disable-next-line no-await-in-loop -- as above
      await builder.api.apps.versions.setCurrent(created.app.id, 1);
      if ("app/server.ts" in blueprint.files) {
        // oxlint-disable-next-line no-await-in-loop -- as above
        await serverBuilt(created.app.id, 1);
      }
      // Its workflows call the App's bindings where a review can name each
      // call, as the check of an agent's draft over it asks, and its steps
      // read as the workflow and review pages outline them: none throws.
      for (const [path, source] of Object.entries(blueprint.files)) {
        if (workflowIdOf(path) !== undefined) {
          checkWorkflowBindings(source);
          describeWorkflow(source);
        }
      }
      // Its screens pass the compiler's checks, with the references they
      // import (`#grasp`), as they do when saved and opened.
      if (
        Object.keys(blueprint.files).some((path) => path.startsWith("screens/"))
      ) {
        // oxlint-disable-next-line no-await-in-loop -- as above
        const files = await withDraftReferences(env, created.app.id, 1, {
          ...blueprint.files,
        });
        // oxlint-disable-next-line no-await-in-loop -- as above
        const screens = await buildScreens(env, files, created.app.id);
        if (!screens.ok || screens.diagnostics.length > 0) {
          throw new Error(
            `The screens of ${blueprint.id} don't pass: ${JSON.stringify(screens.diagnostics)}`
          );
        }
      }
    }
  });

  it("take a changed release once, and leave Apps created from them alone", async () => {
    await reinstall();
    const admin = await signedInApi(idp, "admin");
    const before = await helloRow();
    const created = await admin.api.apps.blueprints.create("hello", {
      name: "Kept",
    });

    const events = await auditedDuring(async () => {
      await expect(install(changedHello())).resolves.toBeTruthy();
      // Installed again with nothing changed: nothing more is written.
      await expect(install(changedHello())).resolves.toBeTruthy();
    });
    const after = await admin.api.apps.blueprints.create("hello", {
      name: "Changed",
    });
    const stored = await helloRow();
    expect({
      changed: stored?.tree !== before?.tree,
      audited: helloActions(events),
      kept: await admin.api.apps.files.read(created.app.id, 1),
      after: await admin.api.apps.files.read(after.app.id, 1),
    }).toStrictEqual({
      changed: true,
      audited: ["blueprint.changed"],
      kept: hello().files,
      after: changedHello().blueprints.find(({ id }) => id === "hello")?.files,
    });

    await reinstall();
  });

  it("take a changed name and description, audited", async () => {
    const admin = await signedInApi(idp, "admin");
    await reinstall();
    const events = await auditedDuring(async () => {
      await expect(
        install(releaseWith({ name: "Hi", description: "Says hi." }))
      ).resolves.toBeTruthy();
    });
    const listed = await admin.api.apps.blueprints.list();
    expect({
      listed: listed
        .filter(({ id }) => id === "hello")
        .map(({ name, description }) => [name, description]),
      audited: events
        .filter(({ target }) => target?.id === "hello")
        .map(({ action, detail }) => [action, detail.name, detail.description]),
    }).toStrictEqual({
      listed: [["Hi", "Says hi."]],
      // What it became: with the events before it, what it was.
      audited: [["blueprint.changed", "Hi", "Says hi."]],
    });

    await reinstall();
  });

  it("create the collections they declare once, open to everyone and changed by admins only", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const id = collectionIdSchema.parse(`greetings-${unique()}`);
    const declared = releaseWith({
      collections: [{ id, name: "Greetings", description: "Said hello." }],
    });
    const events = await auditedDuring(async () => {
      await expect(install(declared)).resolves.toBeTruthy();
      await expect(install(declared)).resolves.toBeTruthy();
    });
    const collection = await env.KNOWLEDGE.prepare(
      "SELECT name, owner, access, source FROM collections WHERE id = ?"
    )
      .bind(id)
      .first();
    const save = async (person: typeof admin) =>
      await outcome(
        person.api.knowledge.saveDocument({
          collectionId: id,
          path: `hello-${unique()}.md`,
          text: "# Hello",
          ifVersion: 0,
        })
      );
    expect({
      collection,
      created: events.filter(
        ({ action, target }) =>
          action === "knowledge.collection.created" && target?.id === id
      ).length,
      admin: await save(admin),
      builder: await save(builder),
    }).toStrictEqual({
      collection: {
        name: "Greetings",
        owner: "grasp",
        access: "everyone",
        source: "here",
      },
      created: 1,
      admin: "ok",
      builder: "knowledge.forbidden",
    });

    await reinstall();
  });

  it("are recorded once when two installs race to change them", async () => {
    await reinstall();
    const changed = changedHello().blueprints.find(({ id }) => id === "hello");
    if (!changed) {
      throw new Error("There's no changed hello");
    }

    const events = await auditedDuring(async () => {
      const racing: Env = {
        ...env,
        DB: dbRacing(async () => {
          await installBuiltinBlueprint(env, changed);
        }),
      };
      // The other install changed it first: this one changes nothing, and
      // records nothing.
      await expect(
        outcome(installBuiltinBlueprint(racing, changed))
      ).resolves.toBe("ok");
    });
    const raced = await helloRow();
    await expect(install(changedHello())).resolves.toBeTruthy();
    expect({
      stored: raced,
      audited: helloActions(events),
    }).toStrictEqual({
      stored: await helloRow(),
      audited: ["blueprint.changed"],
    });

    await reinstall();
  });

  it("aren't recorded as installed after a failure halfway, and the next install finishes", async () => {
    await reinstall();
    const before = await helloRow();
    const down: Env = {
      ...env,
      DB: dbRacing(() => {
        throw new Error("D1 unavailable");
      }),
    };

    await expect(install(changedHello(), down)).resolves.toBeFalsy();
    const stamped = await runInDurableObject(
      builtins(env),
      async (_instance, state) => await state.storage.get("installed")
    );
    expect([stamped, await helloRow()]).toStrictEqual([undefined, before]);

    await expect(install(changedHello())).resolves.toBeTruthy();
    const finished = await helloRow();
    expect(finished?.tree).not.toBe(before?.tree);

    await reinstall();
  });

  it("keep only the tree of the release they are at, and delete one a failed delete left at the next install", async () => {
    await reinstall();
    const before = await helloRow();
    const deletesDown: Env = { ...env, FILES: refusingDeletes(env.FILES) };

    // The row moves on whether or not the old tree is deleted.
    await expect(install(changedHello(), deletesDown)).resolves.toBeTruthy();
    const changed = await helloRow();
    const leftBehind = await helloTrees();
    await expect(install(changedHello())).resolves.toBeTruthy();
    const deletedNext = await helloTrees();
    const admin = await signedInApi(idp, "admin");
    const created = await admin.api.apps.blueprints.create("hello", {
      name: "From the release it is at",
    });
    expect({
      leftBehind,
      deletedNext,
      created: await admin.api.apps.files.read(created.app.id, 1),
    }).toStrictEqual({
      leftBehind: [before?.tree ?? "", changed?.tree ?? ""].toSorted(
        (one, other) => one.localeCompare(other)
      ),
      deletedNext: [changed?.tree],
      created: changedHello().blueprints.find(({ id }) => id === "hello")
        ?.files,
    });

    await reinstall();
    await expect(helloTrees()).resolves.toStrictEqual([before?.tree]);
  });

  it("ask, in each App created from them, for what their release declares, and stop when it no longer does", async () => {
    await reinstall();
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const { collectionId } = await collectionWithNote(admin.api, {
      name: `Declared ${unique()}`,
      access: "everyone",
    });
    const declared = notesOf(collectionId);
    const declaring = releaseWith({ permissions: [declared] });
    // Another release: every isolate installs it again.
    await expect(fingerprintOf(declaring)).resolves.not.toBe(
      await fingerprintOf(release)
    );
    const redeclared = await auditedDuring(async () => {
      await expect(install(declaring)).resolves.toBeTruthy();
      // Installed again: nothing more is written.
      await expect(install(declaring)).resolves.toBeTruthy();
    });
    const listed = await builder.api.apps.blueprints.list();
    expect({
      declared: listed.find(({ id }) => id === "hello")?.permissions,
      audited: helloActions(redeclared),
    }).toStrictEqual({
      declared: [declared],
      audited: ["blueprint.changed"],
    });

    // A copy asks for it, for an admin to grant, and gets it.
    const created = await builder.api.apps.blueprints.create("hello", {
      name: "Asks",
    });
    const [asked] = created.permissions;
    expect(created.permissions).toStrictEqual([
      expect.objectContaining({
        subject: { type: "app", appId: created.app.id },
        ...declared,
        status: "requested",
        requestedBy: builder.userId,
      }),
    ]);
    const granted = await grantReviewed(admin.api, asked?.id ?? "");

    // The release stops declaring it: the copy keeps what it was granted,
    // and a new copy asks for nothing.
    await expect(install(release)).resolves.toBeTruthy();
    const later = await builder.api.apps.blueprints.create("hello", {
      name: "Asks nothing",
    });
    expect({
      copy: await admin.api.permissions.list({
        type: "app",
        appId: created.app.id,
      }),
      later: later.permissions,
    }).toStrictEqual({
      copy: [granted],
      later: [],
    });
  });

  it("leave what a copy was granted as its builder makes its first version current and a release changes them, but not its next version or a rollback", async () => {
    await reinstall();
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const declaring = releaseWith({ permissions: [guests] });
    await expect(install(declaring)).resolves.toBeTruthy();
    const created = await builder.api.apps.blueprints.create("hello", {
      name: "Granted",
    });
    const [asked] = created.permissions;
    const granted = await grantReviewed(admin.api, asked?.id ?? "");
    const copy = { type: "app", appId: created.app.id } as const;

    // Its first version is the blueprint's code, which the admin granted
    // it for; a new release changes the built-in, not the copy.
    const kept = await auditedDuring(async () => {
      await builder.api.apps.versions.setCurrent(created.app.id, 1);
      await expect(
        install(
          releaseWith({
            files: {
              ...hello().files,
              [greetings]: `${hello().files[greetings]}\n// Changed.\n`,
            },
            permissions: [guests],
          })
        )
      ).resolves.toBeTruthy();
    });
    const afterRelease = await admin.api.permissions.list(copy);

    // Code of the builder's own is asked for again.
    const { version } = await builder.api.apps.files.commit(
      created.app.id,
      {
        [greetings]: `${hello().files[greetings]}\n// Mine.\n`,
      },
      "Mine"
    );
    await builder.api.apps.versions.setCurrent(created.app.id, version);
    const next = await admin.api.permissions.list(copy);

    // Granted again for the builder's code, then rolled back to the first
    // version by the builder: asked for again, as for any version but the
    // first one's first time.
    await grantReviewed(admin.api, asked?.id ?? "");
    await builder.api.apps.versions.setCurrent(created.app.id, 1);
    const rolledBack = await admin.api.permissions.list(copy);

    expect({
      audited: kept.filter(
        ({ action, detail }) =>
          action.startsWith("permission.") &&
          detail?.subjectId === created.app.id
      ),
      afterRelease,
      next: next.map(({ status, requestedBy }) => ({ status, requestedBy })),
      rolledBack: rolledBack.map(({ status }) => status),
    }).toStrictEqual({
      audited: [],
      afterRelease: [granted],
      next: [{ status: "requested", requestedBy: builder.userId }],
      rolledBack: ["requested"],
    });

    await reinstall();
  });

  it("have a copy's screens approved by the release while its code is exactly theirs, never over an admin, and only for a copy core made", async () => {
    await expect(install(helloWithScreen())).resolves.toBeTruthy();
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const files = helloWithScreen().blueprints.find(
      ({ id }) => id === "hello"
    )?.files;
    const greeting = files?.[greetings];
    if (!files || greeting === undefined) {
      throw new Error("The release has no hello");
    }
    const { app } = await builder.api.apps.blueprints.create("hello", {
      name: "Vouched",
    });
    const opened: { artifact: string }[] = [];
    const events = await auditedDuring(async () => {
      await builder.api.apps.versions.setCurrent(app.id, 1);
      opened.push(await builder.api.screens.open(app.id, "hello"));
    });
    const [first] = opened;
    if (!first) {
      throw new Error("Nothing was opened");
    }
    const review = await admin.api.screenTrust.review(app.id);

    // Its AGENTS.md written: the same code, built again for the version.
    const { version: noted } = await builder.api.apps.files.commit(
      app.id,
      { "AGENTS.md": "Greets whoever asks.\n" },
      "Notes"
    );
    await builder.api.apps.versions.setCurrent(app.id, noted);
    const sameCode = await outcome(builder.api.screens.open(app.id, "hello"));

    // Code of the builder's own, outside the screen too: an admin's to
    // approve, as any.
    const { version: mine } = await builder.api.apps.files.commit(
      app.id,
      { [greetings]: `${greeting}\n// Mine.\n` },
      "Mine"
    );
    await builder.api.apps.versions.setCurrent(app.id, mine);
    const changed = await outcome(builder.api.screens.open(app.id, "hello"));

    // Back to the first version, then taken back by an admin: their word
    // stands, whatever the release vouches for.
    await builder.api.apps.versions.setCurrent(app.id, 1);
    const back = await outcome(builder.api.screens.open(app.id, "hello"));
    await admin.api.screenTrust.revoke(app.id, first.artifact);
    const revoked = await outcome(builder.api.screens.open(app.id, "hello"));
    // A builder's new version of the same code builds the screen anew (its
    // references name the version): the release vouches for it no more,
    // so it waits for an admin.
    const { version: renoted } = await builder.api.apps.files.commit(
      app.id,
      // Over the builder's own code: the built-in's again.
      {
        "AGENTS.md": "Greets whoever asks, again.\n",
        [greetings]: greeting,
      },
      "Notes again"
    );
    await builder.api.apps.versions.setCurrent(app.id, renoted);
    const afterRevoke = await outcome(
      builder.api.screens.open(app.id, "hello")
    );
    const reviewAfterRevoke = await admin.api.screenTrust.review(app.id);

    // The same code in an App labelled as hello's but not created from
    // it, and in a copy of a marked version of the copy: nobody vouches.
    const labelled = await builder.api.apps.create({
      name: "Labelled",
      blueprint: "hello",
    });
    const { version: own } = await builder.api.apps.files.commit(
      labelled.id,
      files,
      "Hello's code"
    );
    await builder.api.apps.versions.setCurrent(labelled.id, own);
    const { id: marked } = await builder.api.apps.blueprints.mark(app.id, 1);
    const { app: copyOfCopy } = await builder.api.apps.blueprints.create(
      marked,
      { name: "Copy of a copy" }
    );
    await builder.api.apps.versions.setCurrent(copyOfCopy.id, 1);

    expect({
      attested: events
        .filter(({ action }) => action === "app.artifact.attested")
        .map(({ actor, target, detail }) => ({
          actor,
          target: target?.id,
          artifact: detail.artifact,
          version: detail.version,
          screen: detail.screen,
        })),
      review: review.screens.map(({ screen, artifact, trust, decidedBy }) => ({
        screen,
        artifact,
        trust,
        decidedBy,
      })),
      sameCode,
      changed,
      back,
      revoked,
      afterRevoke,
      reviewAfterRevoke: reviewAfterRevoke.screens.map(
        ({ artifact, trust, decidedBy }) => ({
          other: artifact !== first.artifact,
          trust,
          decidedBy,
        })
      ),
      labelled: await outcome(builder.api.screens.open(labelled.id, "hello")),
      copyOfCopy: await outcome(
        builder.api.screens.open(copyOfCopy.id, "hello")
      ),
    }).toStrictEqual({
      attested: [
        {
          actor: { type: "system" },
          target: app.id,
          artifact: first.artifact,
          version: 1,
          screen: "hello",
        },
      ],
      review: [
        {
          screen: "hello",
          artifact: first.artifact,
          trust: "approved",
          decidedBy: "grasp",
        },
      ],
      sameCode: "ok",
      changed: "screen.unreviewed",
      back: "ok",
      revoked: "screen.revoked",
      afterRevoke: "screen.unreviewed",
      reviewAfterRevoke: [
        { other: true, trust: "unreviewed", decidedBy: null },
      ],
      labelled: "screen.unreviewed",
      copyOfCopy: "screen.unreviewed",
    });

    await reinstall();
  });

  it("offer a copy their newer code as an update its builders take or leave, merged over their edits, and made current only as any version", async () => {
    await reinstall();
    const builder = await signedInApi(idp, "builder");
    const stranger = await signedInApi(idp, "builder");
    const { app } = await builder.api.apps.blueprints.create("hello", {
      name: "Edited",
    });
    const { app: untouched } = await builder.api.apps.blueprints.create(
      "hello",
      { name: "Untouched" }
    );
    const unchanged = await builder.api.apps.blueprints.update(app.id);
    const released = await helloRow();

    // The builder's own greeting, made current.
    const mine = `${hello().files[greetings]}\n// Mine.\n`;
    const { version: edited } = await builder.api.apps.files.commit(
      app.id,
      { [greetings]: mine },
      "Mine"
    );
    await builder.api.apps.versions.setCurrent(app.id, edited);

    // A release that changes the greeting too, and the schema.
    const schema = `${hello().files["schema.ts"]}\n// Release 2.\n`;
    const next = releaseWith({
      files: {
        ...hello().files,
        [greetings]: `${hello().files[greetings]}\n// Release 2.\n`,
        "schema.ts": schema,
      },
    });
    await expect(install(next)).resolves.toBeTruthy();
    const installed = await helloRow();
    const offered = await builder.api.apps.blueprints.update(app.id);
    if (!offered) {
      throw new Error("No update was offered");
    }
    // Offered, not applied: the copy is as its builder left it.
    const before = await builder.api.apps.files.read(app.id);
    const stale = await outcome(
      builder.api.apps.blueprints.acceptUpdate(app.id, {
        to: offered.to,
        over: 1,
      })
    );
    const forStranger = await outcome(
      stranger.api.apps.blueprints.update(app.id)
    );

    const accepted: { version: number }[] = [];
    const events = await auditedDuring(async () => {
      accepted.push(
        await builder.api.apps.blueprints.acceptUpdate(app.id, {
          to: offered.to,
          over: edited,
        })
      );
    });
    const [taken] = accepted;
    if (!taken) {
      throw new Error("Nothing was accepted");
    }
    const again = await outcome(
      builder.api.apps.blueprints.acceptUpdate(app.id, {
        to: offered.to,
        over: edited,
      })
    );
    const afterwards = await builder.api.apps.blueprints.update(app.id);
    const { currentVersion: currentBefore } = await builder.api.apps.get(
      app.id
    );
    await builder.api.apps.versions.setCurrent(app.id, taken.version);
    const { currentVersion: current } = await builder.api.apps.get(app.id);

    // A copy nobody edited takes the newer code whole; a copy of a marked
    // version of it is offered nothing, as a marked version never changes.
    const whole = await builder.api.apps.blueprints.update(untouched.id);
    const { version: wholeVersion } =
      await builder.api.apps.blueprints.acceptUpdate(untouched.id, {
        to: offered.to,
        over: 1,
      });
    const { id: marked } = await builder.api.apps.blueprints.mark(
      untouched.id,
      1
    );
    const { app: ofMarked } = await builder.api.apps.blueprints.create(marked, {
      name: "Of a marked one",
    });

    expect({
      unchanged,
      offered: {
        ...offered,
        changes: offered.changes.map(({ path, change }) => [path, change]),
      },
      before: before[greetings],
      stale,
      forStranger,
      audited: events.map(({ action, detail }) => [
        action,
        detail.version ?? null,
      ]),
      files: await builder.api.apps.files.read(app.id, taken.version),
      again,
      afterwards,
      currentBefore,
      current,
      whole: whole?.conflicts,
      wholeFiles: await builder.api.apps.files.read(untouched.id, wholeVersion),
      ofMarked: await builder.api.apps.blueprints.update(ofMarked.id),
    }).toStrictEqual({
      unchanged: null,
      offered: {
        blueprint: "hello",
        from: released?.tree,
        to: installed?.tree,
        over: edited,
        changes: [["schema.ts", "modified"]],
        conflicts: [greetings],
      },
      before: mine,
      stale: "app.conflict",
      forStranger: "app.not_found",
      audited: [
        ["app.committed", taken.version],
        ["app.blueprint.updated", taken.version],
      ],
      files: { ...hello().files, [greetings]: mine, "schema.ts": schema },
      again: "app.conflict",
      afterwards: null,
      currentBefore: edited,
      current: taken.version,
      whole: [],
      wholeFiles: next.blueprints.find(({ id }) => id === "hello")?.files,
      ofMarked: null,
    });

    await reinstall();
  });

  it("give each App created from them a workflow of its creator's own, bound to it, which starts only once an admin grants and approves it", async () => {
    await reinstall();
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const other = await signedInApi(idp, "builder");
    const contract = `fixture/greeter-${unique()}`;
    const shipping = shippingGreeter(contract);
    const installed = await auditedDuring(async () => {
      await expect(install(shipping)).resolves.toBeTruthy();
      // Installed again: the contract is published once.
      await expect(install(shipping)).resolves.toBeTruthy();
    });
    const created = await builder.api.apps.blueprints.create("hello", {
      name: "Greets",
    });
    const theirs = await other.api.apps.blueprints.create("hello", {
      name: "Greets too",
    });
    const [workflow] = await builder.api.workflowResources.list();
    const [otherWorkflow] = await other.api.workflowResources.list();
    if (workflow === undefined || otherWorkflow === undefined) {
      throw new Error("Expected each copy to get a workflow");
    }
    const start = async (app: string, by: string, key: string) =>
      await outcome(
        startAppBinding(env, authorityOf(app, by), "greet", {
          input: { who: "Ada" },
          key,
        })
      );
    const asked = created.permissions.find(
      ({ binding }) => binding === "GREET"
    );

    // Nothing is allowed until an admin says so: not the start, then not
    // the version's model.
    const ungranted = await start(created.app.id, builder.userId, "k1");
    await grantReviewed(admin.api, asked?.id ?? "");
    const unapproved = await start(created.app.id, builder.userId, "k2");
    // The other copy's workflow is its own: the grant isn't its.
    const otherCopy = await start(theirs.app.id, other.userId, "k3");
    await admin.api.workflowResources.approveBinding(workflow.id, {
      alias: "model",
      target: { kind: "model", model: allowedModel },
      reviewed: { version: 1 },
    });
    const gateway = fakeGateway({
      text: '{"line":"Hello, Ada"}',
      inputTokens: 1,
      outputTokens: 1,
    });
    const ai: AiBinding = env.AI;
    vi.spyOn(ai, "fetch").mockImplementation(gateway.binding.fetch);
    const started = await startAppBinding(
      env,
      authorityOf(created.app.id, builder.userId),
      "greet",
      { input: { who: "Ada" }, key: "k4" }
    );
    const { runId } = started;
    if (runId === null) {
      throw new Error("Expected the start to start a run");
    }
    await vi.waitFor(
      async () => {
        const run = await builder.api.workflowResources.run(workflow.id, runId);
        expect(run.endedAt).not.toBeNull();
      },
      { timeout: 30_000, interval: 100 }
    );
    const ran = await builder.api.workflowResources.run(workflow.id, runId);
    vi.restoreAllMocks();

    expect({
      contract: installed
        .filter(({ target }) => target?.id === contract)
        .map(({ action, actor }) => ({ action, actor })),
      workflow: {
        name: workflow.name.startsWith("hello-greet-"),
        owner: workflow.owner,
        currentVersion: workflow.currentVersion,
      },
      distinct: workflow.id !== otherWorkflow.id,
      asked: created.permissions.map(({ object, actions, status }) => ({
        object,
        actions,
        status,
      })),
      ungranted,
      unapproved,
      otherCopy,
      ran: ran.status,
    }).toStrictEqual({
      contract: [
        { action: "workflow.contract.published", actor: { type: "system" } },
      ],
      workflow: { name: true, owner: builder.userId, currentVersion: 1 },
      distinct: true,
      asked: [
        {
          object: { type: "workflow", workflowId: workflow.id },
          actions: ["start"],
          status: "requested",
        },
      ],
      ungranted: "workflow.start_denied",
      unapproved: "workflow.binding_unapproved",
      otherCopy: "workflow.start_denied",
      ran: "completed",
    });

    await reinstall();
  });

  it("publish a copy's workflow as its own, whatever workflow the release's definition names", async () => {
    await reinstall();
    const builder = await signedInApi(idp, "builder");
    const owner = await signedInApi(idp, "builder");
    const contract = `fixture/greeter-${unique()}`;
    // Someone else's workflow, which the release's definition names.
    const victim = await owner.api.workflowResources.create(
      `victim-${unique()}`
    );
    await expect(
      install(shippingGreeter(contract, greeter(contract, victim.name)))
    ).resolves.toBeTruthy();
    await builder.api.apps.blueprints.create("hello", { name: "Names" });
    const [workflow] = await builder.api.workflowResources.list();
    const definition = z
      .object({
        document: z.object({ namespace: z.string(), name: z.string() }),
      })
      .parse(
        JSON.parse(
          await builder.api.workflowResources.definition(workflow?.id ?? "", 1)
        )
      );
    expect({
      named: definition.document.name === workflow?.name,
      namespace: definition.document.namespace,
      victim: await owner.api.workflowResources.versions(victim.id),
    }).toStrictEqual({
      named: true,
      namespace: workflowNamespace,
      victim: [],
    });

    await reinstall();
  });

  it("make no workflow, and no App, for a definition that wouldn't publish", async () => {
    await reinstall();
    const builder = await signedInApi(idp, "builder");
    const contract = `fixture/greeter-${unique()}`;
    // The definition binds a contract the catalog doesn't hold.
    const unpublishable = releaseWith({
      workflows: [
        { alias: "greet", binding: "GREET", definition: greeter(contract) },
      ],
    });
    await expect(install(unpublishable)).resolves.toBeTruthy();
    const refused = await outcome(
      builder.api.apps.blueprints.create("hello", { name: "Refused" })
    );
    const listed = await builder.api.apps.list();
    expect({
      refused,
      workflows: await builder.api.workflowResources.list(),
      apps: listed.filter(({ name }) => name === "Refused"),
    }).toStrictEqual({
      refused: "workflow.definition_invalid",
      workflows: [],
      apps: [],
    });

    await reinstall();
  });

  it("delete the workflows they made for a copy refused partway through making them", async () => {
    await reinstall();
    const builder = await signedInApi(idp, "builder");
    const contract = `fixture/greeter-${unique()}`;
    await expect(
      install(
        releaseWith({
          contracts: [{ key: contract, kind: "model" }],
          workflows: [
            { alias: "greet", binding: "GREET", definition: greeter(contract) },
            { alias: "wave", binding: "WAVE", definition: greeter(contract) },
          ],
        })
      )
    ).resolves.toBeTruthy();
    // Room for one workflow: the second is refused once the first is made.
    const configured = quotaLimitsSchema.parse(env.QUOTA_LIMITS);
    env.QUOTA_LIMITS = {
      generation: configured.generation + 200,
      limits: { ...configured.limits, workflowResourcesPerPerson: 1 },
    };
    let refused: string;
    try {
      refused = await outcome(
        builder.api.apps.blueprints.create("hello", { name: "Partway" })
      );
    } finally {
      env.QUOTA_LIMITS = {
        generation: configured.generation + 201,
        limits: configured.limits,
      };
    }
    const counted = await env.DB.prepare(
      "SELECT count(*) AS made, count(*) FILTER (WHERE deleted_at IS NULL) AS live FROM workflow_resources WHERE owner_id = ?"
    )
      .bind(builder.userId)
      .first<{ made: number; live: number }>();
    const listed = await builder.api.apps.list();
    expect({
      refused,
      made: counted?.made,
      live: counted?.live,
      apps: listed.filter(({ name }) => name === "Partway"),
    }).toStrictEqual({
      refused: "workflow.resource_limit",
      made: 1,
      live: 0,
      apps: [],
    });

    await reinstall();
  });

  it("delete the workflows they made for a copy whose App is refused", async () => {
    await reinstall();
    const builder = await signedInApi(idp, "builder");
    const contract = `fixture/greeter-${unique()}`;
    await expect(install(shippingGreeter(contract))).resolves.toBeTruthy();
    // The built-in gone just before the batch that creates the App lands:
    // the App is refused after its workflow was made.
    const racing = racingDb(
      async () =>
        await env.DB.prepare("DELETE FROM blueprints WHERE id = 'hello'").run(),
      /^insert into "apps"/iu
    );
    const refused = await outcome(
      createFromBlueprint(
        { ...env, DB: racing },
        await builder.api.whoami(),
        "hello",
        { name: "Raced" }
      )
    );
    const deleted = await env.DB.prepare(
      "SELECT count(*) AS made, count(*) FILTER (WHERE deleted_at IS NULL) AS live FROM workflow_resources WHERE owner_id = ?"
    )
      .bind(builder.userId)
      .first<{ made: number; live: number }>();
    expect({ refused, made: deleted?.made, live: deleted?.live }).toStrictEqual(
      {
        refused: "app.blueprint_not_found",
        made: 1,
        live: 0,
      }
    );

    await reinstall();
  });

  it("are installed again as blueprints, with no App of the previous install left, by the first install after the migrations that make them records", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const { collectionId } = await collectionWithNote(admin.api, {
      name: `Migrated ${unique()}`,
      access: "everyone",
    });
    const declared = notesOf(collectionId);
    const declaring = releaseWith({ permissions: [declared] });
    // As the previous releases left a deployment: the built-in an App owned
    // by Grasp, with a version and its own request, no blueprint row (the
    // new table starts empty), and the singleton holding that release's
    // fingerprint.
    const previous = "builtin-hello";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Hello', '', 'grasp', 0)"
      ).bind(previous),
      env.DB.prepare(
        "INSERT INTO app_versions (app_id, version, tree, files, author_id, message, created_at, approved) VALUES (?, 1, 'tree', 1, 'grasp', 'From the release', 0, 1)"
      ).bind(previous),
      env.DB.prepare("DELETE FROM blueprints WHERE id = 'hello'"),
    ]);
    await storedGrant(
      { type: "app", id: previous },
      { type: "collection", id: collectionId },
      ["read"],
      "NOTES",
      "requested"
    );
    const { id: other } = await builder.api.apps.create({
      name: `Other ${unique()}`,
    });
    const kept = await storedGrant(
      { type: "app", id: other },
      { type: "collection", id: collectionId },
      ["read"],
      "NOTES",
      "requested"
    );
    const migrations = z
      .array(z.object({ name: z.string(), queries: z.array(z.string()) }))
      .parse(testBinding("CORE_MIGRATIONS"))
      .filter(
        ({ name }) =>
          name.includes("blueprint_declared_permissions") ||
          name.includes("drop_app_blueprints")
      );
    // What they do to rows, as a deploy runs them: the table they change is
    // already gone here.
    for (const { queries } of migrations) {
      for (const query of queries) {
        if (query.trim().startsWith("DELETE")) {
          // oxlint-disable-next-line no-await-in-loop -- in order, as D1 applies them
          await env.DB.prepare(query).run();
        }
      }
    }
    const installed = await runInDurableObject(
      builtins(env),
      async (_instance, state) => {
        await state.storage.put("installed", "the previous release's");
        return await installBuiltins(env, state.storage, declaring);
      }
    );

    const listed = await builder.api.apps.blueprints.list();
    const { results: apps } = await env.DB.prepare(
      "SELECT id FROM apps WHERE owner_id = 'grasp'"
    ).all<{ id: string }>();
    const { results: left } = await env.DB.prepare(
      "SELECT id FROM permissions WHERE subject_id IN (?, ?)"
    )
      .bind(previous, other)
      .all<{ id: string }>();
    expect({
      installed,
      declared: listed.find(({ id }) => id === "hello")?.permissions,
      apps,
      left: left.map(({ id }) => id),
    }).toStrictEqual({
      installed: true,
      declared: [declared],
      apps: [],
      // The built-in's own request is gone; anyone else's stays.
      left: [kept],
    });

    await reinstall();
  });
});
