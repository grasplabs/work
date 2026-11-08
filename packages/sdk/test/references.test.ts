import { sealedBuildLimits } from "@grasp-os/shared/sealed-builds";
import { describe, expect, test } from "vite-plus/test";

import { decisionFingerprint } from "../src/codegen-contracts.ts";
import {
  contractFingerprint,
  declaredWorkflows,
  eventFingerprint,
  generateModules,
  inspectApp,
  readAppManifest,
  readSealedWorkflows,
  registerApp,
  symbolicModules,
  workflowFingerprint,
  workflowQueries,
} from "../src/host.ts";
import type {
  AppManifest,
  BoundWorkflow,
  WorkflowBindingExtras,
  ServerModules,
} from "../src/host.ts";
import type { AnyOperationReference } from "../src/index.ts";
import { defineApp, permission, v } from "../src/index.ts";
import { runFunction } from "../src/runner.ts";
import type { OperationChannel } from "../src/runner.ts";
import { serverModule } from "../src/server.ts";
import { valueLimits } from "../src/value-descriptor.ts";
import { schemaOf } from "../src/value-schema.ts";
import type { AnySchema } from "../src/value-schema.ts";
import { defineSchema, defineTable } from "../src/values.ts";
import { workflowReferenceLimits } from "../src/workflow-references.ts";
import { notesWorkflows } from "./notes-workflows.ts";
import notes from "./notes/.grasp/app.ts";
import contractsText from "./notes/.grasp/contracts.json?raw";
import { archiveNotes, summarizeNote } from "./notes/grasp.config.ts";
// oxlint-disable-next-line import/default -- a ?raw import is the file's text
import referencesText from "./notes/server/_generated/api.ts?raw";
import { api, permissions, workflows } from "./notes/server/_generated/api.ts";
// oxlint-disable-next-line import/default -- a ?raw import is the file's text
import dataModelText from "./notes/server/_generated/dataModel.ts?raw";
// oxlint-disable-next-line import/default -- a ?raw import is the file's text
import serverReferencesText from "./notes/server/_generated/internal.ts?raw";
import { internal } from "./notes/server/_generated/internal.ts";
// oxlint-disable-next-line import/default -- a ?raw import is the file's text
import serverText from "./notes/server/_generated/server.ts?raw";

// References and generated modules (spec 7.3, 8, 32.1), and reading an
// App's manifest back as the host does: pure logic, so unit tests. The
// Notes fixture (test/notes) is an App as the product lays it out, and
// its `server/_generated/` and `.grasp/` are what the host generates for
// it: the first test fails whenever the generator or the fixture changes
// without the other.
// Sealing and running through the real sandbox are core's tests.

const identity = {
  resourceId: "app_0000000000000000000000notes",
  resourceVersion: 1,
};

/** The fixture's manifest, as inspection makes it. */
const notesManifest = (): AppManifest => inspectApp(notes).manifest;

/** `manifest` as JSON text, as a sandbox answers it. */
const textOf = (manifest: unknown): string => JSON.stringify(manifest);

/** The message of what `run` throws. */
const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("It was accepted");
};

/** Where something is in JSON data: its keys and indexes, in order. */
type Path = readonly (string | number)[];

/** What is at `path` in `data`, or undefined. */
const at = (data: unknown, path: Path): unknown => {
  let node = data;
  for (const key of path) {
    node =
      typeof node === "object" && node !== null
        ? Reflect.get(node, key)
        : undefined;
  }
  return node;
};

/** Sets what is at `path` in `data` to `value`. */
const setAt = (data: unknown, path: Path, value: unknown): void => {
  const parent = at(data, path.slice(0, -1));
  const last = path.at(-1);
  if (typeof parent !== "object" || parent === null || last === undefined) {
    throw new Error(`Nothing at ${path.join(".")}`);
  }
  Reflect.set(parent, last, value);
};

/** Removes what is at `path` in `data`. */
const removeAt = (data: unknown, path: Path): void => {
  const parent = at(data, path.slice(0, -1));
  const last = path.at(-1);
  if (typeof parent !== "object" || parent === null || last === undefined) {
    throw new Error(`Nothing at ${path.join(".")}`);
  }
  Reflect.deleteProperty(parent, last);
};

/** The fixture's manifest as JSON data, changed by `change`. */
const changed = (change: (data: unknown) => void): string => {
  const data: unknown = JSON.parse(textOf(notesManifest()));
  change(data);
  return textOf(data);
};

describe("generated modules", () => {
  test("are what the host generates for the fixture, byte for byte", async () => {
    const files = await generateModules(
      readAppManifest(textOf(notesManifest())),
      identity,
      notesWorkflows
    );
    expect(files).toStrictEqual({
      "server/_generated/server.ts": serverText,
      "server/_generated/dataModel.ts": dataModelText,
      "server/_generated/internal.ts": serverReferencesText,
      "server/_generated/api.ts": referencesText,
      ".grasp/contracts.json": contractsText,
    });
  });

  test("are the same bytes whatever order the manifest's keys come in", async () => {
    const manifest = notesManifest();
    const reversed: unknown = JSON.parse(
      textOf(manifest),
      (_key, value: unknown) =>
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).toReversed())
          : value
    );
    await expect(
      generateModules(readAppManifest(textOf(reversed)), identity)
    ).resolves.toStrictEqual(await generateModules(manifest, identity));
  });

  test("change the contract fingerprint a binding pins with any change to a function", async () => {
    const manifest = notesManifest();
    const create = manifest.operations["notes.create"];
    if (create === undefined) {
      throw new Error("No notes.create");
    }
    const pinned = await contractFingerprint(create);
    const changes = [
      { ...create, kind: "action" as const },
      { ...create, visibility: "internal" as const },
      { ...create, returns: v.string().descriptor },
      { ...create, returns: null },
      { ...create, stream: v.null().descriptor },
    ];
    for (const change of changes) {
      // One after the other: each is compared with the original.
      // oxlint-disable-next-line no-await-in-loop -- see above
      await expect(contractFingerprint(change)).resolves.not.toBe(pinned);
    }
  });

  test("hold what a page calls and checks a function by, nothing of the release, frozen all the way down", () => {
    const { operations } = notesManifest();
    const references = [api.notes.create, api.notes.exportAll, api.notes.list];
    expect({
      // A mutation's and an action's (a streaming one's too: core knows
      // it streams): the kind `useForm` sends by, and the arguments it
      // checks a form with.
      create: api.notes.create,
      exportAll: {
        kind: api.notes.exportAll.kind,
        args: api.notes.exportAll.args,
      },
      // A query's: what it answers, which a grid reads its columns from,
      // and no kind, which its hook says.
      list: {
        returns: api.notes.list.returns,
        kind: Reflect.has(api.notes.list, "kind"),
      },
      // Nothing that changes from one release to the next.
      ofRelease: references.flatMap((reference) =>
        ["resourceId", "resourceVersion", "contractId", "fingerprint"].filter(
          (key) => Reflect.has(reference, key)
        )
      ),
    }).toStrictEqual({
      create: {
        name: "notes.create",
        kind: "mutation",
        args: operations["notes.create"]?.args,
      },
      exportAll: { kind: "action", args: operations["notes.exportAll"]?.args },
      list: { returns: operations["notes.list"]?.returns, kind: false },
      ofRelease: [],
    });
    // The phantom types exist in types only.
    expect(Object.getOwnPropertySymbols(api.notes.create)).toStrictEqual([]);
    expect([
      Object.isFrozen(api),
      Object.isFrozen(api.notes),
      Object.isFrozen(api.notes.create),
      Object.isFrozen(permissions.files.operations),
      Reflect.set(api.notes.create, "name", "notes.remove"),
    ]).toStrictEqual([true, true, true, true, false]);
  });

  test("name functions the same whatever release or version they are generated for", async () => {
    // Without workflows, whose references still carry the release they
    // were bound in: every reference here is a name.
    const fixture = notesManifest();
    const manifest = {
      ...fixture,
      permissions: Object.fromEntries(
        Object.entries(fixture.permissions).filter(
          ([, declared]) => declared["~permission"] !== "workflows"
        )
      ),
    };
    const [one, other] = await Promise.all([
      generateModules(manifest, identity),
      generateModules(manifest, {
        resourceId: "app_00000000000000000000000other",
        resourceVersion: 7,
      }),
    ]);
    expect({
      api:
        other["server/_generated/api.ts"] === one["server/_generated/api.ts"],
      internal:
        other["server/_generated/internal.ts"] ===
        one["server/_generated/internal.ts"],
    }).toStrictEqual({ api: true, internal: true });
  });

  test("keep internal functions out of the browser's api", () => {
    expect(Object.keys(api.notes).toSorted()).toStrictEqual([
      "create",
      "exportAll",
      "get",
      "list",
      "remove",
      "setSummary",
      "tally",
      "update",
    ]);
    expect(internal.notes.count).toMatchObject({ name: "notes.count" });
    expect(referencesText).not.toContain("notes.count");
  });

  test("keep handlers, schemas and server modules out of what a browser imports", () => {
    for (const forbidden of [
      "handler",
      "schema.ts",
      "@grasp-os/sdk/server",
      "serverModule",
      "server/",
      "internal",
    ]) {
      expect(referencesText).not.toContain(forbidden);
    }
  });

  test("expose the pages' permissions with their literal operations and origins, and only those", () => {
    expect(permissions).toStrictEqual({
      files: {
        kind: "files",
        alias: "files",
        operations: ["upload", "read", "attach"],
      },
      links: {
        kind: "links",
        alias: "links",
        origins: ["https://help.example.com"],
      },
    });
  });

  test("export no workflows for an App that declares none", async () => {
    const manifest = notesManifest();
    const files = await generateModules(
      {
        ...manifest,
        permissions: Object.fromEntries(
          Object.entries(manifest.permissions).filter(
            ([, declared]) => declared["~permission"] !== "workflows"
          )
        ),
      },
      identity
    );
    expect(files["server/_generated/api.ts"]).toContain(
      "export const workflows: Readonly<Record<never, never>> = frozen({});"
    );
  });
});

/** A descriptor `depth` levels deep: objects around a null. */
const nested = (depth: number) => {
  let schema: AnySchema = v.null();
  for (let level = 1; level < depth; level += 1) {
    schema = v.object({ inner: schema });
  }
  return schema.descriptor;
};

/** One last page of `items`, as a paginated query answers it. */
const pageOf = (items: unknown[]) => ({
  items,
  nextCursor: null,
  hasMore: false,
});

describe("workflow references", () => {
  const [summarize] = notesWorkflows;
  if (summarize === undefined) {
    throw new Error("No bound workflows");
  }

  /**
   * The fixture's generated modules, with what the host resolved of its
   * workflows, `bound`, and its declaration of `summarizeNote` changed by
   * `declared`, if given.
   */
  const generatedWith = async (
    bound: readonly WorkflowBindingExtras[],
    declared?: Partial<Pick<BoundWorkflow, "input" | "output">>
  ) => {
    const manifest = notesManifest();
    return await generateModules(
      declared === undefined
        ? manifest
        : {
            ...manifest,
            permissions: {
              ...manifest.permissions,
              summarizeNote: { ...summarizeNote, ...declared },
            },
          },
      identity,
      bound
    );
  };

  test("seal the workflow version each was resolved from, never into a reference", async () => {
    const pinned = { workflowId: "workflow-1", version: 3 };
    const files = await generatedWith([{ ...summarize, pinned }]);
    const contracts: unknown = JSON.parse(
      files[".grasp/contracts.json"] ?? "{}"
    );
    const sealedWorkflows: unknown =
      typeof contracts === "object" && contracts !== null
        ? Reflect.get(contracts, "workflows")
        : undefined;
    expect({
      sealed: readSealedWorkflows(sealedWorkflows)
        .filter(({ alias }) => alias === summarize.alias)
        .map((workflow) => workflow.pinned),
      inReferences: (files["server/_generated/api.ts"] ?? "").includes(
        "workflow-1"
      ),
    }).toStrictEqual({ sealed: [pinned], inReferences: false });
  });

  test.each([
    ["no workflow", { version: 1 }],
    ["an empty workflow", { workflowId: "", version: 1 }],
    ["a version that isn't one", { workflowId: "workflow-1", version: 0 }],
    ["a fractional version", { workflowId: "workflow-1", version: 1.5 }],
  ])("refuse a sealed pin with %s", (_case, pinned) => {
    expect(() =>
      readSealedWorkflows({
        summarizeNote: {
          alias: "summarizeNote",
          events: {},
          listens: {},
          decisions: {},
          pinned,
        },
      })
    ).toThrow(/pin/u);
  });

  test("hold their contract and their events as data, and have no .start, .get or .cancel", () => {
    for (const reference of Object.values(workflows)) {
      expect(Object.keys(reference).toSorted()).toStrictEqual([
        "alias",
        "contractId",
        "decisions",
        "events",
        "fingerprint",
        "input",
        "kind",
        "listens",
        "output",
        "queries",
        "resourceId",
        "resourceVersion",
        "visibility",
      ]);
      // Data all the way down: a clone refuses a function, and keeps all.
      expect(structuredClone(reference)).toStrictEqual(reference);
      expect(Object.isFrozen(reference.events)).toBeTruthy();
    }
    expect(workflows.summarizeNote).toMatchObject({
      kind: "workflow",
      visibility: "public",
      ...identity,
      alias: "summarizeNote",
      contractId: "workflows.summarizeNote",
      input: summarizeNote.input,
      output: summarizeNote.output,
      listens: summarize.listens,
    });
  });

  test("bind each event to its workflow binding, the contract it pins and its event type", async () => {
    const reference = workflows.summarizeNote;
    expect(reference.fingerprint).toBe(
      await workflowFingerprint(summarizeNote)
    );
    const expected = await Promise.all(
      Object.entries(summarize.events).map(async ([alias, declared]) => [
        alias,
        {
          kind: "workflowEvent",
          ...identity,
          workflow: "workflows.summarizeNote",
          workflowFingerprint: reference.fingerprint,
          alias,
          type: declared.type,
          fingerprint: await eventFingerprint(declared),
          data: declared.data,
        },
      ])
    );
    expect(reference.events).toStrictEqual(Object.fromEntries(expected));
  });

  test("bind each decision to its workflow binding and key, with its value schema as a descriptor", async () => {
    const reference = workflows.summarizeNote;
    const expected = await Promise.all(
      Object.entries(summarize.decisions).map(async ([key, declared]) => [
        key,
        {
          kind: "workflowDecision",
          ...identity,
          workflow: "workflows.summarizeNote",
          workflowFingerprint: reference.fingerprint,
          key,
          fingerprint: await decisionFingerprint(declared),
          valueSchema: { kind: "descriptor", descriptor: declared.value },
          context: declared.context,
        },
      ])
    );
    expect(reference.decisions).toStrictEqual(Object.fromEntries(expected));
    // A form's schema is built from it, and checks what the decision does.
    const response = v.object({
      approved: v.boolean(),
      value: reference.decisions.approveSummary.valueSchema,
    });
    expect(
      response["~standard"].validate({
        approved: true,
        value: { comment: "Checked.", rating: 4 },
      }).issues
    ).toBeUndefined();
    expect(
      response["~standard"].validate({
        approved: true,
        value: { comment: "Checked.", rating: 9 },
      }).issues
    ).toBeDefined();
    // A descriptor schema is read back as any stored descriptor is.
    const forged: unknown = JSON.parse(
      '{"kind":"descriptor","descriptor":{"kind":"anything"}}'
    );
    expect(() => {
      Reflect.apply(v.object, undefined, [{ value: forged }]);
    }).toThrow(
      expect.objectContaining({ code: "definition.invalid_descriptor" })
    );
  });

  test("expose runs, history, the decision inbox and a decision as public query references, by name", async () => {
    const queries = Object.entries(workflows).flatMap(([alias, reference]) =>
      Object.entries<AnyOperationReference>(reference.queries).map(
        ([name, query]) => ({
          path: `workflows.${alias}.queries.${name}`,
          query,
        })
      )
    );
    expect(queries.map(({ path }) => path).toSorted()).toStrictEqual(
      ["archiveNotes", "summarizeNote"].flatMap((alias) =>
        ["decision", "decisions", "history", "runs"].map(
          (name) => `workflows.${alias}.queries.${name}`
        )
      )
    );
    for (const { path, query } of queries) {
      expect(query.name).toBe(path);
    }
    // A workflow that asks nobody has no inbox, and no decision rows.
    const files = await generatedWith([
      { alias: "archiveNotes", events: {}, listens: {}, decisions: {} },
    ]);
    const text = files["server/_generated/api.ts"] ?? "";
    expect(text).toContain("workflows.archiveNotes.queries.history");
    expect(text).not.toContain("workflows.archiveNotes.queries.decision");
  });

  test("hold as many decisions as a reference does, contexts nested one level short of the limit, and refuse deeper by name", async () => {
    const many: WorkflowBindingExtras = {
      ...summarize,
      decisions: Object.fromEntries(
        Array.from(
          { length: workflowReferenceLimits.decisions },
          (_, index) => [
            `decision${index}`,
            { value: v.null().descriptor, context: v.null().descriptor },
          ]
        )
      ),
    };
    const deep = (depth: number): WorkflowBindingExtras => ({
      ...summarize,
      decisions: {
        deep: { value: v.null().descriptor, context: nested(depth) },
      },
    });
    const files = await generatedWith([many]);
    expect(files["server/_generated/api.ts"]).toContain(
      `WorkflowDecisionDetail<"decision${workflowReferenceLimits.decisions - 1}"`
    );
    await expect(
      generatedWith([deep(valueLimits.depth - 1)])
    ).resolves.toBeDefined();
    await expect(generatedWith([deep(valueLimits.depth)])).rejects.toThrow(
      "summarizeNote's decision contexts don't fit its decision query"
    );
  });

  test("answer only what each query declares: declared keys, no output, a known context", () => {
    // What core checks each query's answer against, by the binding.
    const bound = declaredWorkflows(notesManifest(), notesWorkflows).find(
      ({ alias }) => alias === "summarizeNote"
    );
    if (bound === undefined) {
      throw new Error("The fixture binds summarizeNote");
    }
    const queries = workflowQueries(bound);
    const historyRow = {
      id: "h-1",
      sequence: 4,
      taskId: "do/2/awaitEdit",
      at: 1000,
      kind: "event",
      eventId: "e-1",
      key: "noteEdited",
      state: "accepted",
    };
    const runRow = {
      run: {
        runId: "run-1",
        workflowId: "wf-1",
        workflowVersion: 2,
        manifestHash: "m",
      },
      status: "completed",
      startedAt: 1000,
      finishedAt: 2000,
      canWatch: true,
    };
    const detail = {
      key: "chooseLength",
      wait: {
        kind: "decision",
        id: "w-1",
        taskId: "do/3/length",
        key: "chooseLength",
        title: "Length",
        openedAt: 1000,
        deadline: null,
        canRespond: true,
      },
      prompt: "How long?",
      context: { words: 120 },
      canRespond: true,
    };
    const cases = {
      history: [queries.history, pageOf([historyRow])],
      "history: an undeclared event": [
        queries.history,
        pageOf([{ ...historyRow, key: "documentUploaded" }]),
      ],
      "history: a run's input": [
        queries.history,
        pageOf([{ ...historyRow, input: { noteId: "n" } }]),
      ],
      runs: [queries.runs, pageOf([runRow])],
      "runs: a run's output": [
        queries.runs,
        pageOf([{ ...runRow, output: { summary: "s" } }]),
      ],
      decision: [queries.decision, detail],
      "decision: closed": [queries.decision, null],
      "decision: another decision's context": [
        queries.decision,
        { ...detail, context: { summary: "s" } },
      ],
      "decision: another decision's wait": [
        queries.decision,
        { ...detail, wait: { ...detail.wait, key: "approveSummary" } },
      ],
    } as const;
    const accepted = Object.fromEntries(
      Object.entries(cases).map(([what, [query, value]]) => [
        what,
        query?.returns !== undefined &&
          query.returns !== null &&
          schemaOf(query.returns)["~standard"].validate(value).issues ===
            undefined,
      ])
    );
    expect(accepted).toStrictEqual({
      history: true,
      "history: an undeclared event": false,
      "history: a run's input": false,
      runs: true,
      "runs: a run's output": false,
      decision: true,
      "decision: closed": true,
      "decision: another decision's context": false,
      "decision: another decision's wait": false,
    });
  });

  test("pin the workflow's input and output, each event and decision its own contract, and the release all of it", async () => {
    const text = v.string().descriptor;
    const declarationChanges = [{ input: text }, { output: text }];
    const workflowPrints = await Promise.all(
      [{}, ...declarationChanges].map(
        async (change) =>
          await workflowFingerprint({ ...summarizeNote, ...change })
      )
    );
    expect(new Set(workflowPrints).size).toBe(workflowPrints.length);

    const edited = summarize.events.noteEdited;
    if (edited === undefined) {
      throw new Error("No noteEdited");
    }
    const eventPrints = await Promise.all(
      [
        edited,
        { ...edited, type: "notes.note.changed" },
        { ...edited, data: text },
      ].map(eventFingerprint)
    );
    expect(new Set(eventPrints).size).toBe(eventPrints.length);

    const approve = summarize.decisions.approveSummary;
    if (approve === undefined) {
      throw new Error("No approveSummary");
    }
    const decisionPrints = await Promise.all(
      [approve, { ...approve, value: text }, { ...approve, context: text }].map(
        decisionFingerprint
      )
    );
    expect(new Set(decisionPrints).size).toBe(decisionPrints.length);

    const contractChanges: WorkflowBindingExtras[] = [
      {
        ...summarize,
        events: { ...summarize.events, noteEdited: { ...edited, data: text } },
      },
      {
        ...summarize,
        events: { ...summarize.events, extra: { type: "x", data: text } },
      },
      { ...summarize, listens: { "do/0/chooseStyle": ["styleChosen"] } },
      {
        ...summarize,
        decisions: {
          ...summarize.decisions,
          chooseLength: { value: text, context: text },
        },
      },
      {
        ...summarize,
        decisions: {
          ...summarize.decisions,
          approveSummary: {
            value: approve.value,
            context: text,
          },
        },
      },
      { ...summarize, decisions: {} },
    ];
    const contracts = await Promise.all([
      ...[summarize, ...contractChanges].map(async (workflow) => {
        const files = await generatedWith([workflow]);
        return files[".grasp/contracts.json"];
      }),
      ...declarationChanges.map(async (change) => {
        const files = await generatedWith([summarize], change);
        return files[".grasp/contracts.json"];
      }),
    ]);
    expect(new Set(contracts).size).toBe(contracts.length);
  });

  test("are the same bytes whatever order the workflows, their events and their listen tasks' events come in", async () => {
    const reversed = notesWorkflows.toReversed().map((workflow) => ({
      ...workflow,
      events: Object.fromEntries(Object.entries(workflow.events).toReversed()),
      listens: Object.fromEntries(
        Object.entries(workflow.listens)
          .toReversed()
          .map(([task, events]) => [task, events.toReversed()])
      ),
    }));
    await expect(generatedWith(reversed)).resolves.toStrictEqual(
      await generatedWith(notesWorkflows)
    );
  });

  test("are covered by the contracts the release's hash covers", async () => {
    const files = await generatedWith(notesWorkflows, {
      output: v.string().descriptor,
    });
    expect(files[".grasp/contracts.json"]).not.toBe(contractsText);
    expect(JSON.parse(contractsText)).toMatchObject({
      workflowFingerprints: {
        archiveNotes: await workflowFingerprint(archiveNotes),
        summarizeNote: await workflowFingerprint(summarizeNote),
      },
    });
  });

  test("hold exactly as many events as the client reads (workflowReferenceLimits)", async () => {
    const files = await generatedWith([
      {
        ...summarize,
        events: Object.fromEntries(
          Array.from({ length: workflowReferenceLimits.events }, (_, index) => [
            `event${index}`,
            { type: "x", data: v.null().descriptor },
          ])
        ),
        listens: {},
      },
    ]);
    expect(files["server/_generated/api.ts"]).toContain(
      `event${workflowReferenceLimits.events - 1}`
    );
  });

  test("are made for every workflow the App declares, with the contract it declares, whatever the host resolved of it", async () => {
    const files = await generatedWith([]);
    const references = files["server/_generated/api.ts"] ?? "";
    // Pinned to what the App declares: the same contract, and fingerprint.
    expect(references).toContain(await workflowFingerprint(summarizeNote));
    expect(references).toContain(await workflowFingerprint(archiveNotes));
    expect(JSON.parse(files[".grasp/contracts.json"] ?? "")).toMatchObject({
      workflows: {
        archiveNotes: { events: {}, listens: {}, decisions: {} },
        summarizeNote: { events: {}, listens: {}, decisions: {} },
      },
    });
  });

  test.each<[string, readonly WorkflowBindingExtras[]]>([
    ["the same alias twice", [summarize, summarize]],
    [
      "a workflow the App doesn't declare",
      [{ ...summarize, alias: "translateNote" }],
    ],
    ["an alias that isn't plain", [{ ...summarize, alias: "summarize-note" }]],
    [
      "an event alias that isn't plain",
      [
        {
          ...summarize,
          events: { "note edited": { type: "x", data: v.null().descriptor } },
          listens: {},
        },
      ],
    ],
    [
      "a decision key that isn't plain",
      [
        {
          ...summarize,
          decisions: {
            "approve summary": {
              value: v.null().descriptor,
              context: v.null().descriptor,
            },
          },
        },
      ],
    ],
    [
      "a listen task for an event the workflow doesn't declare",
      [{ ...summarize, listens: { "do/0/wait": ["documentUploaded"] } }],
    ],
    [
      "a listen task listing the same event twice",
      [
        {
          ...summarize,
          listens: { "do/2/awaitEdit": ["noteEdited", "noteEdited"] },
        },
      ],
    ],
    [
      "a listen task for no event at all",
      [{ ...summarize, listens: { "do/0/wait": [] } }],
    ],
    [
      "more events than a reference holds",
      [
        {
          ...summarize,
          events: Object.fromEntries(
            Array.from(
              { length: workflowReferenceLimits.events + 1 },
              (_, index) => [
                `event${index}`,
                { type: "x", data: v.null().descriptor },
              ]
            )
          ),
          listens: {},
        },
      ],
    ],
    [
      "an event with an empty type",
      [
        {
          ...summarize,
          events: {
            ...summarize.events,
            noteEdited: { type: "", data: v.null().descriptor },
          },
        },
      ],
    ],
    [
      "an event type longer than a reference holds",
      [
        {
          ...summarize,
          events: {
            ...summarize.events,
            noteEdited: {
              type: "t".repeat(sealedBuildLimits.eventTypeLength + 1),
              data: v.null().descriptor,
            },
          },
        },
      ],
    ],
    [
      "an event type with a control character inside",
      [
        {
          ...summarize,
          events: {
            ...summarize.events,
            noteEdited: { type: "note\tedited", data: v.null().descriptor },
          },
        },
      ],
    ],
    [
      "an event type with a space at its end",
      [
        {
          ...summarize,
          events: {
            ...summarize.events,
            noteEdited: { type: "note.edited ", data: v.null().descriptor },
          },
        },
      ],
    ],
    [
      "more decisions than a reference holds",
      [
        {
          ...summarize,
          decisions: Object.fromEntries(
            Array.from(
              { length: workflowReferenceLimits.decisions + 1 },
              (_, index) => [
                `decision${index}`,
                { value: v.null().descriptor, context: v.null().descriptor },
              ]
            )
          ),
        },
      ],
    ],
    [
      "a listen task's path longer than a reference holds",
      [
        {
          ...summarize,
          listens: {
            ["t".repeat(workflowReferenceLimits.taskPathLength + 1)]: [
              "noteEdited",
            ],
          },
        },
      ],
    ],
  ])("refuse %s", async (_what, bound) => {
    await expect(generatedWith(bound)).rejects.toThrow(TypeError);
  });
});

describe("symbolic references", () => {
  test("resolve against the registration by path, and never survive into generated modules", () => {
    const modules = symbolicModules();
    expect(Object.keys(modules).toSorted()).toStrictEqual([
      "server/_generated/api.ts",
      "server/_generated/internal.ts",
    ]);
    expect(Object.values(modules).join("\n")).toContain("new Proxy");
    expect([referencesText, serverReferencesText].join("\n")).not.toContain(
      "Proxy"
    );
  });
});

const schema = defineSchema({
  notes: defineTable({ title: v.string() }).access({ read: "appMembers" }),
});
const server = serverModule(schema);
const list = server.query({
  args: {},
  returns: v.null(),
  handler: () => null,
});
const secret = server.internalQuery({
  args: {},
  returns: v.number(),
  handler: () => 1,
});
const send = server.action({
  args: {},
  returns: v.null(),
  handler: () => null,
});

// SAFETY: a deliberately ill-typed view, for declarations the types refuse.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const looseDefineApp = defineApp as (
  config: unknown
) => ReturnType<typeof defineApp>;
// SAFETY: as above.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const looseAction = server.action as (declaration: unknown) => unknown;
// SAFETY: as above.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const loosePermission = permission as Record<
  "files" | "links",
  (config: unknown) => unknown
>;

/** The small App's server modules: `server/notes.ts`. */
const smallModules: ServerModules = { notes: { list, send, secret } };

/**
 * A small App, with `changes` to its registration, and its functions from
 * `modules` (its server modules, `smallModules` unless given).
 */
const small = (
  changes: Record<string, unknown> = {},
  modules: ServerModules = smallModules
) =>
  registerApp({
    config: looseDefineApp({ name: "Small", ...changes }),
    schema,
    modules,
    migrations: [],
  });

describe("references a function calls", () => {
  test("reach the runner as the path they name", async () => {
    const reference = internal.notes.count;
    const calls: unknown[] = [];
    const channel: OperationChannel = {
      read: async () => await Promise.reject(new Error("no reads")),
      write: async () => await Promise.reject(new Error("no writes")),
      call: async (...args) => {
        calls.push(args);
        return await Promise.resolve(3);
      },
      resource: async () => await Promise.reject(new Error("no resources")),
      emit: async () => await Promise.reject(new Error("no emits")),
      people: async () => await Promise.reject(new Error("no people")),
    };
    await expect(runFunction(notes, "notes.tally", {}, channel)).resolves.toBe(
      3
    );
    expect(calls).toStrictEqual([["query", reference.name, {}]]);
  });
});

describe("reserved segments", () => {
  test.each(["name", "then"])(
    "no function registers at a segment named %s, at any depth",
    (name) => {
      expect(
        refusal(() => small({}, { notes: { list, [name]: send } }))
      ).toContain("is a name a reference itself answers");
      expect(refusal(() => small({}, { [name]: { list } }))).toContain(
        "is a name a reference itself answers"
      );
    }
  );
});

describe("the platform's path segments", () => {
  test.each([
    ["public", "workflows", { "workflows/review/queries": { runs: list } }],
    ["internal", "workflows", { workflows: { secret } }],
  ])(
    "no %s function registers under the %s segment",
    (_case, _segment, modules) => {
      expect(refusal(() => small({}, modules))).toContain("is the platform's");
    }
  );

  test("a nested workflows segment is the App's own", () => {
    expect(() =>
      small({}, { notes: { list }, "admin/workflows": { send } })
    ).not.toThrow();
  });
});

describe("browser permissions", () => {
  test.each([
    ["plain HTTP", ["http://help.example.com"]],
    ["a path", ["https://help.example.com/docs"]],
    ["upper case", ["https://Help.example.com"]],
    ["a wildcard", ["https://*.example.com"]],
    ["credentials", ["https://user@help.example.com"]],
    ["a trailing slash", ["https://help.example.com/"]],
    ["no origin at all", []],
  ])("links with %s are refused", (_case, origins) => {
    expect(() => loosePermission.links({ origins })).toThrow(/origin/u);
  });

  test("links accept a host name and a port as an exact origin", () => {
    expect(
      permission.links({ origins: ["https://help.example.com:8443"] }).origins
    ).toStrictEqual(["https://help.example.com:8443"]);
  });

  test.each([
    [
      "an IPv6 address not as the URL standard writes it",
      "https://[2001:DB8:0::1]",
    ],
    ["an IPv6 address with a path", "https://[2001:db8::1]/docs"],
    ["an IPv6 address", "https://[2001:db8::1]"],
    ["an IPv4 address", "https://192.0.2.1"],
    ["a trailing dot", "https://help.example.com."],
    ["an empty label", "https://help..example.com"],
    ["the home network's name", "https://home.arpa"],
    ["a loopback address", "https://127.0.0.1"],
    ["a private address", "https://10.0.0.8"],
    ["a link-local IPv6 address", "https://[fe80::1]"],
    ["localhost", "https://localhost"],
    ["a private-use name", "https://wiki.internal"],
    ["a name of one label", "https://intranet"],
  ])("links with %s are refused too", (_case, origin) => {
    expect(() => loosePermission.links({ origins: [origin] })).toThrow(
      /origin/u
    );
  });

  test("files list only the operations there are, each once", () => {
    expect(() =>
      loosePermission.files({ operations: ["upload", "share"] })
    ).toThrow(/can't have/u);
    expect(() =>
      loosePermission.files({ operations: ["read", "read"] })
    ).toThrow(/twice/u);
  });

  test("share one namespace of aliases with the actions' permissions", () => {
    const files = permission.files({ operations: ["read"] });
    const connection = permission.connection("files", {
      contract: "microsoft-365.mail@1",
      actions: ["send"],
    });
    expect(
      refusal(() =>
        small({ permissions: { files, connections: [connection] } })
      )
    ).toContain("Two of the App's permissions have alias `files`");
  });

  test("are the App's, never listed by a function", () => {
    const files = permission.files({ operations: ["read"] });
    expect(() =>
      looseAction({
        args: {},
        returns: v.null(),
        uses: [files],
        handler: () => null,
      })
    ).toThrow("An action's declaration has no `uses`.");
  });
});

describe("reading a manifest back", () => {
  test("gives exactly the manifest inspection made", () => {
    const manifest = notesManifest();
    expect(readAppManifest(textOf(manifest))).toStrictEqual(manifest);
  });

  test.each([
    [
      "a function's own uses",
      (data: unknown) => {
        setAt(data, ["operations", "notes.tally", "uses"], []);
      },
      "isn't a function as a manifest holds one",
    ],
    [
      "a function's own table verbs",
      (data: unknown) => {
        setAt(data, ["operations", "notes.get", "tables"], {
          notes: { read: true, insert: true, update: true, delete: true },
        });
      },
      "isn't a function as a manifest holds one",
    ],
    [
      "a query that streams",
      (data: unknown) => {
        setAt(
          data,
          ["operations", "notes.get", "stream"],
          v.object({}).descriptor
        );
      },
      "A query's declaration has no `stream`.",
    ],
    [
      "a key no manifest has",
      (data: unknown) => {
        setAt(data, ["admin"], true);
      },
      "An App's manifest is",
    ],
    [
      "a key no function has",
      (data: unknown) => {
        setAt(data, ["operations", "notes.get", "grants"], ["admin"]);
      },
      "isn't a function as a manifest holds one",
    ],
    [
      "a function filed under another path",
      (data: unknown) => {
        setAt(data, ["operations", "notes.get", "path"], "notes.list");
      },
      "path, kind or visibility",
    ],
    [
      "a kind there isn't",
      (data: unknown) => {
        setAt(data, ["operations", "notes.get", "kind"], "admin");
      },
      "path, kind or visibility",
    ],
    [
      "a path that clashes with another",
      (data: unknown) => {
        const get = at(data, ["operations", "notes.get"]);
        setAt(data, ["operations", "notes.get.more"], {
          ...(typeof get === "object" ? get : {}),
          path: "notes.get.more",
        });
      },
      "clashes with another registered path",
    ],
    [
      "a connection under the alias of the pages' links",
      (data: unknown) => {
        setAt(data, ["permissions", "links"], {
          "~permission": "connections",
          alias: "links",
          contract: "microsoft-365.mail@1",
          actions: ["send"],
        });
      },
      "is the alias of the App's `links` permission",
    ],
    [
      "a permission filed under another alias",
      (data: unknown) => {
        setAt(
          data,
          ["permissions", "manual"],
          at(data, ["permissions", "links"])
        );
        removeAt(data, ["permissions", "links"]);
      },
      "filed under its alias",
    ],
    [
      "a link origin that isn't exact",
      (data: unknown) => {
        setAt(
          data,
          ["permissions", "links", "origins"],
          ["https://example.com/a"]
        );
      },
      "exact HTTPS origin",
    ],
    [
      "a descriptor of a kind there isn't",
      (data: unknown) => {
        setAt(data, ["operations", "notes.get", "returns", "kind"], "script");
      },
      "kind isn't one this SDK knows",
    ],
    [
      "arguments that aren't an object",
      (data: unknown) => {
        setAt(data, ["operations", "notes.get", "args"], v.string().descriptor);
      },
      "arguments are an object",
    ],
    [
      "arguments that may be null as a whole, which no declaration makes",
      (data: unknown) => {
        setAt(data, ["operations", "notes.get", "args", "nullable"], true);
      },
      "isn't what its declaration makes",
    ],
    [
      "a stream on a query",
      (data: unknown) => {
        setAt(data, ["operations", "notes.get", "stream"], v.null().descriptor);
      },
      "A query's declaration has no `stream`",
    ],
    [
      "a name too long",
      (data: unknown) => {
        setAt(data, ["name"], "x".repeat(101));
      },
      "1 to 100 characters",
    ],
    [
      "access a declaration couldn't give",
      (data: unknown) => {
        setAt(
          data,
          ["schema", "tables", "notes", "access", "read"],
          "everyone"
        );
      },
      "",
    ],
  ])("refuses %s", (_case, change, message) => {
    expect(refusal(() => readAppManifest(changed(change)))).toContain(message);
  });

  test("refuses text that isn't JSON, isn't text, or is too large", () => {
    expect(refusal(() => readAppManifest("{"))).toContain("isn't JSON");
    expect(
      refusal(() => Reflect.apply(readAppManifest, undefined, [{}]))
    ).toContain("JSON text");
    expect(
      refusal(() => readAppManifest(`"${"x".repeat(4 * 1024 * 1024)}"`))
    ).toContain("at most");
  });

  test("refuses a descriptor nested too deep before following it", () => {
    let deep: unknown = v.string().descriptor;
    for (let level = 0; level < 200; level += 1) {
      deep = { ...v.array(v.string()).descriptor, item: deep };
    }
    expect(
      refusal(() =>
        readAppManifest(
          changed((data) => {
            setAt(data, ["operations", "notes.get", "returns"], deep);
          })
        )
      )
    ).toContain("nests too deep");
  });
});
