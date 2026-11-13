import { createHash } from "node:crypto";

import {
  definitionSources,
  generatedFiles,
  readDefinition,
} from "@grasp-os/runtime/definition";
import { appLimits } from "@grasp-os/shared/app-limits";
import { collectionIdSchema, appIdSchema } from "@grasp-os/shared/ids";
import type { CollectionId } from "@grasp-os/shared/ids";
import type {
  DeclaredPermission,
  Authority,
} from "@grasp-os/shared/permissions";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
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
import { blueprintsDigestText } from "../src/builtin-digest.ts";
import {
  builtins,
  fingerprintOf,
  installBuiltins,
  loadBuiltinRelease,
} from "../src/builtins.ts";
import type { Release } from "../src/builtins.ts";
import { withDraftReferences } from "../src/draft-references.ts";
import { buildPages } from "../src/pages.ts";
import { appOf } from "./app-definitions.ts";
import { commitApp, grantReviewed, racingDb } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, storedGrant } from "./knowledge.ts";
import { fakeProvider, testModel } from "./model-provider.ts";
import { configuredLimits } from "./quota-limits.ts";
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

/**
 * A migration's statement that deletes rows: readD1Migrations keeps the
 * comments before each statement.
 */
const deleteStatement = /^DELETE\b/mu;

/** This release's built-ins, blueprints included. */
const release = await loadBuiltinRelease();

const hello = (): BuiltinBlueprint => {
  const found = release.blueprints.find(({ id }) => id === "hello");
  if (!found) {
    throw new Error("The global setup didn't embed the tests' built-in");
  }
  return found;
};

/**
 * The files an App created from `blueprint` (of a release) holds: its own,
 * and what Grasp generates among them (`server/_generated/`), as every
 * version's.
 */
const committed = (
  blueprint: Pick<BuiltinBlueprint, "files" | "definition"> | undefined
): Readonly<Record<string, string>> | undefined =>
  blueprint === undefined
    ? undefined
    : appOf(readDefinition(JSON.parse(blueprint.definition)), blueprint.files)
        .files;

/** The singleton's install, asked for by an isolate of this release. */
const ensureInstalled = async (): Promise<boolean> =>
  await builtins(env).ensureInstalled(await fingerprintOf(release));

/**
 * This release, with each built-in changed as `change` says of it: another
 * release, with the digest its build would embed.
 */
const releaseChanging = (
  change: (blueprint: BuiltinBlueprint) => Partial<BuiltinBlueprint>
): Release => {
  const blueprints = release.blueprints.map((blueprint) => ({
    ...blueprint,
    ...change(blueprint),
  }));
  return {
    ...release,
    blueprints,
    blueprintsDigest: createHash("sha256")
      .update(blueprintsDigestText(blueprints))
      .digest("hex"),
  };
};

/**
 * This release, with `hello` changed as `change` says: another release,
 * with the digest its build would embed.
 */
const releaseWith = (change: Partial<BuiltinBlueprint>): Release =>
  releaseChanging((blueprint) => (blueprint.id === "hello" ? change : {}));

/** Where `hello` keeps its greeting, a function of its release. */
const greetings = "server/greetings.ts";

/** A file a later release of the built-in adds. */
const helperPath = "values.ts";

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
    "SELECT name, description, tree, definition, permissions FROM blueprints WHERE id = 'hello'"
  ).first<{
    name: string;
    description: string;
    tree: string;
    definition: string;
    permissions: string;
  }>();

/** The SHA-256 of a stored definition's text, as an update names it. */
const definitionHash = (text = ""): string =>
  createHash("sha256").update(text).digest("hex");

/**
 * `hello`'s definition with its one field's stable ID `id`: the same
 * names and types, so the same code.
 */
const helloReIded = (id: string): string => {
  const text = hello().definition.replace('"id2"', `"${id}"`);
  if (text === hello().definition) {
    throw new Error("hello's field is no longer id2");
  }
  return text;
};

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

/** A workflow value of an object of `fields`, all required. */
const objectSchema = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

/**
 * A workflow a release ships with `hello`: a model, bound as `model` to
 * the catalog's `contract`, greets its input's `who`.
 */
const greeter = (contract: string): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ line: { kind: "string" } }),
    result: { line: { $expr: "greet.line" } },
    permissions: { ai: { contract } },
    steps: [
      {
        id: "greet",
        type: "generate",
        instructions: "Greet them.",
        input: { who: { $expr: "args.who" } },
        returns: objectSchema({ line: { kind: "string" } }),
      },
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

/** `one` before `other`, by their IDs. */
const byId = (one: { id: string }, other: { id: string }): number =>
  one.id.localeCompare(other.id);

/** A built-in's name, as a changed release names it. */
const renamed = (name: string): string => `${name}, changed`;

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

  it("hold their config and schema exactly as their definition generates them", () => {
    expect(
      release.blueprints.map(({ id, files }) => ({
        id,
        generated: {
          [generatedFiles.config]: files[generatedFiles.config],
          [generatedFiles.schema]: files[generatedFiles.schema],
        },
      }))
    ).toStrictEqual(
      release.blueprints.map(({ id, definition }) => ({
        id,
        generated: definitionSources(readDefinition(JSON.parse(definition))),
      }))
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
    await builder.api.versions.rollback({ kind: "app", id: created.app.id }, 1);
    expect({
      blueprint: created.app.blueprint,
      owner: created.app.owner,
      permissions: created.permissions,
      files: await builder.api.versions.files(
        { kind: "app", id: created.app.id },
        1
      ),
      greeting: await calledAs(
        await builder.api.whoami(),
        created.app.id,
        { name: "greetings.hello", kind: "mutation" },
        { name: "Ann" }
      ),
    }).toStrictEqual({
      blueprint: "hello",
      owner: builder.userId,
      permissions: [],
      files: committed(hello()),
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
    const listed = await admin.api.apps.list();

    expect({
      // No App for anyone to change, run, share or ask permissions for.
      apps: listed.filter(({ owner }) => owner === "grasp"),
      unmark: await outcome(admin.api.apps.blueprints.unmark("hello")),
      calls: await outcome(
        admin.api.permissions.request({
          subject: { type: "agent", agentId: `agent-${unique()}` },
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

  // One test per built-in, each within its own time limit: on a slow
  // runner only a built-in that is slow fails, and a new one is covered as
  // it ships. Each signs in a builder of its own, so a retry never finds
  // an App an attempt before it created.
  it.each(release.blueprints.map((blueprint) => [blueprint.id, blueprint]))(
    "each create an App that builds: %s",
    async (_id, blueprint) => {
      await expect(ensureInstalled()).resolves.toBeTruthy();
      const builder = await signedInApi(idp, "builder");
      const created = await builder.api.apps.blueprints.create(blueprint.id, {
        name: blueprint.name,
      });
      // It becomes current, as its creator makes it.
      await builder.api.versions.rollback(
        { kind: "app", id: created.app.id },
        1
      );
      // Its pages pass the compiler's checks, with the references they
      // import (`@server/_generated/api`), as they do when saved and opened.
      if (
        Object.keys(blueprint.files).some((path) =>
          path.startsWith("src/routes/")
        )
      ) {
        const { files } = await withDraftReferences(env, created.app.id, {
          ...blueprint.files,
        });
        const pages = await buildPages(env, files, created.app.id);
        if (!pages.ok || pages.diagnostics.length > 0) {
          throw new Error(
            `The pages of ${blueprint.id} don't pass: ${JSON.stringify(pages.diagnostics)}`
          );
        }
      }
    }
  );

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
      kept: await admin.api.versions.files(
        { kind: "app", id: created.app.id },
        1
      ),
      after: await admin.api.versions.files(
        { kind: "app", id: after.app.id },
        1
      ),
    }).toStrictEqual({
      changed: true,
      audited: ["blueprint.changed"],
      kept: committed(hello()),
      after: committed(
        changedHello().blueprints.find(({ id }) => id === "hello")
      ),
    });

    await reinstall();
  });

  it("each take a changed name and the longest description an App may have, audited", async () => {
    const admin = await signedInApi(idp, "admin");
    await reinstall();
    // Every built-in the release ships, the tests' own and the real ones:
    // one the install rejects leaves every install after it partial.
    const description = "d".repeat(appLimits.descriptionLength);
    const events = await auditedDuring(async () => {
      await expect(
        install(
          releaseChanging(({ name }) => ({ name: renamed(name), description }))
        )
      ).resolves.toBeTruthy();
    });
    const ids = new Set(release.blueprints.map(({ id }) => id));
    const listed = await admin.api.apps.blueprints.list();
    expect({
      listed: listed
        .filter(({ id }) => ids.has(id))
        .toSorted(byId)
        .map(({ id, name, description: listedDescription }) => [
          id,
          name,
          listedDescription,
        ]),
      audited: events
        .filter(({ target }) => ids.has(target?.id ?? ""))
        .map(({ action, target, detail }) => ({
          id: target?.id ?? "",
          action,
          name: detail.name,
          description: detail.description,
        }))
        .toSorted(byId),
    }).toStrictEqual({
      listed: release.blueprints
        .toSorted(byId)
        .map(({ id, name }) => [id, renamed(name), description]),
      // What each became, the description by its SHA-256: the audit log
      // keeps identifiers, never content.
      audited: release.blueprints.toSorted(byId).map(({ id, name }) => ({
        id,
        action: "blueprint.changed",
        name: renamed(name),
        description: createHash("sha256").update(description).digest("hex"),
      })),
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
      created: await admin.api.versions.files(
        { kind: "app", id: created.app.id },
        1
      ),
    }).toStrictEqual({
      leftBehind: [before?.tree ?? "", changed?.tree ?? ""].toSorted(
        (one, other) => one.localeCompare(other)
      ),
      deletedNext: [changed?.tree],
      created: committed(
        changedHello().blueprints.find(({ id }) => id === "hello")
      ),
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

  it("leave what a copy was granted as its builder makes a version current, a release changes the built-in, or a rollback", async () => {
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

    // Its first version, then a new release of the built-in, then code
    // of the builder's own, then back to the first: the grant is of the
    // access, whichever version runs.
    const kept = await auditedDuring(async () => {
      await builder.api.versions.rollback(
        { kind: "app", id: created.app.id },
        1
      );
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
      const { version } = await commitApp(builder.api, created.app.id, {
        [greetings]: `${hello().files[greetings]}\n// Mine.\n`,
      });
      await builder.api.versions.rollback(
        { kind: "app", id: created.app.id },
        version
      );
      await builder.api.versions.rollback(
        { kind: "app", id: created.app.id },
        1
      );
    });

    expect({
      audited: kept.filter(
        ({ action, detail }) =>
          action.startsWith("permission.") &&
          detail?.subjectId === created.app.id
      ),
      after: await admin.api.permissions.list(copy),
    }).toStrictEqual({
      audited: [],
      after: [granted],
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
    const { version: edited } = await commitApp(builder.api, app.id, {
      [greetings]: mine,
    });
    await builder.api.versions.rollback({ kind: "app", id: app.id }, edited);

    // A release that changes the greeting too, and adds a helper.
    const helper =
      "export const shout = (text: string) => text.toUpperCase();\n";
    const next = releaseWith({
      files: {
        ...hello().files,
        [greetings]: `${hello().files[greetings]}\n// Release 2.\n`,
        [helperPath]: helper,
      },
    });
    await expect(install(next)).resolves.toBeTruthy();
    const installed = await helloRow();
    const offered = await builder.api.apps.blueprints.update(app.id);
    if (!offered) {
      throw new Error("No update was offered");
    }
    // Offered, not applied: the copy is as its builder left it.
    const before = await builder.api.drafts.files({ kind: "app", id: app.id });
    const stale = await outcome(
      builder.api.apps.blueprints.acceptUpdate(app.id, {
        to: offered.to,
        definition: offered.definition,
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
          definition: offered.definition,
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
        definition: offered.definition,
        over: edited,
      })
    );
    const afterwards = await builder.api.apps.blueprints.update(app.id);
    const { currentVersion: currentBefore } = await builder.api.apps.get(
      app.id
    );
    await builder.api.versions.rollback(
      { kind: "app", id: app.id },
      taken.version
    );
    const { currentVersion: current } = await builder.api.apps.get(app.id);

    // A copy nobody edited takes the newer code whole; a copy of a marked
    // version of it is offered nothing, as a marked version never changes.
    const whole = await builder.api.apps.blueprints.update(untouched.id);
    const { version: wholeVersion } =
      await builder.api.apps.blueprints.acceptUpdate(untouched.id, {
        to: offered.to,
        definition: offered.definition,
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
      files: await builder.api.versions.files(
        { kind: "app", id: app.id },
        taken.version
      ),
      again,
      afterwards,
      currentBefore,
      current,
      whole: whole?.conflicts,
      wholeFiles: await builder.api.versions.files(
        { kind: "app", id: untouched.id },
        wholeVersion
      ),
      ofMarked: await builder.api.apps.blueprints.update(ofMarked.id),
    }).toStrictEqual({
      unchanged: null,
      offered: {
        blueprint: "hello",
        from: released?.tree,
        to: installed?.tree,
        definition: definitionHash(installed?.definition),
        over: edited,
        changes: [[helperPath, "added"]],
        conflicts: [greetings],
        definitionConflict: false,
      },
      before: mine,
      stale: "app.conflict",
      forStranger: "app.not_found",
      audited: [
        ["app.committed", taken.version],
        ["app.blueprint.updated", taken.version],
      ],
      files: committed({
        definition: hello().definition,
        files: { ...hello().files, [greetings]: mine, [helperPath]: helper },
      }),
      again: "app.conflict",
      afterwards: null,
      currentBefore: edited,
      current: taken.version,
      whole: [],
      wholeFiles: committed(next.blueprints.find(({ id }) => id === "hello")),
      ofMarked: null,
    });

    await reinstall();
  });

  it("refuse an update whose blueprint's definition changed after it was offered, though its code didn't", async () => {
    await reinstall();
    const builder = await signedInApi(idp, "builder");
    const { app } = await builder.api.apps.blueprints.create("hello", {
      name: "Offered",
    });
    const changed = changedHello();
    await install(changed);
    const offered = await builder.api.apps.blueprints.update(app.id);
    if (!offered) {
      throw new Error("No update was offered");
    }
    // The blueprint's field takes another stable ID: no file changes.
    const changedFiles = changed.blueprints.find(
      ({ id }) => id === "hello"
    )?.files;
    await install(
      releaseWith({ files: changedFiles, definition: helloReIded("id9") })
    );
    const now = await builder.api.apps.blueprints.update(app.id);

    expect({
      sameCode: now?.to === offered.to,
      stale: await outcome(
        builder.api.apps.blueprints.acceptUpdate(app.id, {
          to: offered.to,
          definition: offered.definition,
          over: offered.over,
        })
      ),
    }).toStrictEqual({ sameCode: true, stale: "app.conflict" });

    await reinstall();
  });

  it("say a definition both a copy and its blueprint changed is a conflict, though the code each generates is the same", async () => {
    await reinstall();
    const builder = await signedInApi(idp, "builder");
    const { app } = await builder.api.apps.blueprints.create("hello", {
      name: "Re-IDed",
    });
    // Each side gives the one field another stable ID: the same code.
    const created = await builder.api.drafts.files({ kind: "app", id: app.id });
    const subject = { kind: "app", id: app.id } as const;
    const { revision } = await builder.api.drafts.get(subject);
    await builder.api.apps.editDraft(app.id, {
      revision,
      changes: { "AGENTS.md": created["AGENTS.md"] ?? "" },
      definition: JSON.parse(helloReIded("id7")),
    });
    const { version } = await builder.api.drafts.publish(subject, revision + 1);
    await install(releaseWith({ definition: helloReIded("id8") }));
    const offered = await builder.api.apps.blueprints.update(app.id);
    const taken =
      offered === null
        ? null
        : await builder.api.apps.blueprints.acceptUpdate(app.id, {
            to: offered.to,
            definition: offered.definition,
            over: offered.over,
          });

    expect({
      changes: offered?.changes,
      conflicts: offered?.conflicts,
      definitionConflict: offered?.definitionConflict,
      // The copy's definition stays: nothing to publish.
      taken: taken?.version,
    }).toStrictEqual({
      changes: [],
      conflicts: [],
      definitionConflict: true,
      taken: version,
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
          args: { who: "Ada" },
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
    await fakeProvider({
      text: '{"line":"Hello, Ada"}',
      inputTokens: 1,
      outputTokens: 1,
    });
    await admin.api.workflowResources.approveBinding(workflow.id, {
      alias: "ai",
      target: { kind: "model", model: testModel },
      reviewed: { version: 1 },
    });
    const started = await startAppBinding(
      env,
      authorityOf(created.app.id, builder.userId),
      "greet",
      { args: { who: "Ada" }, key: "k4" }
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
    env.TEST_QUOTA_LIMITS = {
      ...configuredLimits,
      workflowResourcesPerPerson: 1,
    };
    let refused: string;
    try {
      refused = await outcome(
        builder.api.apps.blueprints.create("hello", { name: "Partway" })
      );
    } finally {
      env.TEST_QUOTA_LIMITS = configuredLimits;
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
        if (deleteStatement.test(query)) {
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
