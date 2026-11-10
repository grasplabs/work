import { sealedBuildLimits } from "@grasp-os/shared/sealed-builds";
import { describe, expect, test } from "vite-plus/test";

import {
  contractFingerprint,
  declaredWorkflows,
  generateModules,
  inspectApp,
  readAppManifest,
  readSealedWorkflows,
  registerApp,
  symbolicModules,
  workflowFingerprint,
  workflowFunctions,
} from "../src/host.ts";
import type {
  AppManifest,
  BoundWorkflow,
  WorkflowBindingExtras,
  ServerModules,
} from "../src/host.ts";
import type { AnyFunctionReference } from "../src/index.ts";
import { defineApp, permission, v } from "../src/index.ts";
import { readPageBuild } from "../src/page-functions.ts";
import { runFunction } from "../src/runner.ts";
import type { FunctionChannel } from "../src/runner.ts";
import { serverModule } from "../src/server.ts";
import { isPlainObject, valueLimits } from "../src/value-descriptor.ts";
import { schemaOf } from "../src/value-schema.ts";
import type { AnySchema } from "../src/value-schema.ts";
import { defineSchema, defineTable } from "../src/values.ts";
import { workflowReferenceLimits } from "../src/workflow-references.ts";
import notes from "./notes/.grasp/app.ts";
import contractsText from "./notes/.grasp/contracts.json?raw";
// oxlint-disable-next-line import/default -- a ?raw import is the file's text
import functionsText from "./notes/.grasp/functions.ts?raw";
import { functions as builtFunctions } from "./notes/.grasp/functions.ts";
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
      readAppManifest(textOf(notesManifest()))
    );
    expect(files).toStrictEqual({
      "server/_generated/server.ts": serverText,
      "server/_generated/dataModel.ts": dataModelText,
      "server/_generated/internal.ts": serverReferencesText,
      "server/_generated/api.ts": referencesText,
      ".grasp/contracts.json": contractsText,
      ".grasp/functions.ts": functionsText,
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
      generateModules(readAppManifest(textOf(reversed)))
    ).resolves.toStrictEqual(await generateModules(manifest));
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

  test("are each function's name alone, frozen all the way down", () => {
    const references = [
      api.notes.create,
      api.notes.exportAll,
      api.notes.list,
      api.notes.titles,
      internal.notes.count,
    ];
    expect(references).toStrictEqual([
      { name: "notes.create" },
      { name: "notes.exportAll" },
      { name: "notes.list" },
      { name: "notes.titles" },
      { name: "notes.count" },
    ]);
    // The phantom types exist in types only.
    expect(Object.getOwnPropertySymbols(api.notes.create)).toStrictEqual([]);
    expect([
      Object.isFrozen(api),
      Object.isFrozen(api.notes),
      Object.isFrozen(api.notes.create),
      Object.isFrozen(internal.notes.count),
      Object.isFrozen(permissions.files.operations),
      Reflect.set(api.notes.create, "name", "notes.remove"),
    ]).toStrictEqual([true, true, true, true, true, false]);
  });

  test("give a page the release's public functions by name, its workflows' too, as data a client reads them from", () => {
    const { operations } = notesManifest();
    const create = operations["notes.create"];
    const build = readPageBuild(builtFunctions);
    const releaseFunctions = build.functions;
    expect(releaseFunctions.get("notes.create")).toStrictEqual({
      kind: "mutation",
      args: create?.args,
      returns: create?.returns,
    });
    // Never an internal function's, and a query without `returns` says so.
    expect({
      internal: releaseFunctions.has("notes.count"),
      titles: releaseFunctions.get("notes.titles")?.returns,
      start: releaseFunctions.get("workflows.summarizeNote.mutations.start")
        ?.kind,
    }).toStrictEqual({ internal: false, titles: null, start: "mutation" });
    // Each workflow as the App declares it, by alias.
    const summarize = build.workflows.get("summarizeNote");
    expect({
      workflows: [...build.workflows.keys()].toSorted(),
      events: Object.fromEntries(summarize?.events ?? []),
      listens: Object.fromEntries(
        [...(summarize?.listens ?? [])].map(([task, events]) => [
          task,
          [...events],
        ])
      ),
      decisions: Object.fromEntries(summarize?.decisions ?? []),
    }).toStrictEqual({
      workflows: ["archiveNotes", "summarizeNote"],
      events: summarizeNote.events,
      listens: summarizeNote.listens,
      decisions: summarizeNote.decisions,
    });
  });

  test("name functions the same whatever version, contract or pin they are generated for", async () => {
    const manifest = notesManifest();
    // Another version, whose functions take and answer other values, and
    // whose workflows were bound to other versions: the references are
    // the code's names, and their types the code's own.
    const create = manifest.operations["notes.create"];
    if (create === undefined) {
      throw new Error("No notes.create");
    }
    const changedContracts = {
      ...manifest,
      operations: {
        ...manifest.operations,
        "notes.create": {
          ...create,
          args: v.object({ heading: v.string() }).descriptor,
          returns: null,
        },
      },
    };
    const [one, other] = await Promise.all([
      generateModules(manifest),
      generateModules(changedContracts, [
        {
          alias: "summarizeNote",
          pinned: { workflowId: "workflow-7", version: 7 },
        },
      ]),
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
      "tallied",
      "tally",
      "titles",
      "update",
    ]);
    expect(internal.notes.count).toMatchObject({ name: "notes.count" });
    expect(referencesText).not.toContain("notes.count");
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
    const files = await generateModules({
      ...manifest,
      permissions: Object.fromEntries(
        Object.entries(manifest.permissions).filter(
          ([, declared]) => declared["~permission"] !== "workflows"
        )
      ),
    });
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

/** What a test changes of a workflow the fixture declares. */
type DeclaredChange = Partial<
  Pick<BoundWorkflow, "args" | "returns" | "events" | "listens" | "decisions">
>;

const builtFunctionsPattern = /JSON\.parse\((?<text>".*")\);/u;

/** The page's build in generated `files`, as a client reads it. */
const pageBuildOf = (files: Readonly<Record<string, string>>) => {
  const text = builtFunctionsPattern.exec(files[".grasp/functions.ts"] ?? "")
    ?.groups?.text;
  if (text === undefined) {
    throw new Error("No page build");
  }
  const json: unknown = JSON.parse(text);
  const build: unknown = typeof json === "string" ? JSON.parse(json) : null;
  return readPageBuild(build);
};

describe("workflow references", () => {
  const pinned = { workflowId: "workflow-1", version: 3 };

  /**
   * The fixture's generated modules, with the versions the host resolved
   * its workflow bindings to, `bound`, and its declarations of
   * `summarizeNote` and `archiveNotes` changed by `declared`, if given.
   */
  const generatedWith = async (
    bound: readonly WorkflowBindingExtras[],
    declared: {
      readonly summarizeNote?: DeclaredChange;
      readonly archiveNotes?: DeclaredChange;
    } = {}
  ) => {
    const manifest = notesManifest();
    return await generateModules(
      {
        ...manifest,
        permissions: {
          ...manifest.permissions,
          summarizeNote: { ...summarizeNote, ...declared.summarizeNote },
          archiveNotes: { ...archiveNotes, ...declared.archiveNotes },
        },
      },
      bound
    );
  };

  test("seal the workflow version each was resolved from, never into a reference or a page", async () => {
    const files = await generatedWith([{ alias: "summarizeNote", pinned }]);
    const contracts: unknown = JSON.parse(
      files[".grasp/contracts.json"] ?? "{}"
    );
    expect({
      // `archiveNotes`, bound to nothing, seals nothing.
      sealed: readSealedWorkflows(at(contracts, ["workflows"])),
      inReferences: (files["server/_generated/api.ts"] ?? "").includes(
        "workflow-1"
      ),
      inPage: (files[".grasp/functions.ts"] ?? "").includes("workflow-1"),
    }).toStrictEqual({
      sealed: [{ alias: "summarizeNote", pinned }],
      inReferences: false,
      inPage: false,
    });
  });

  test.each([
    ["no pin at all", undefined],
    ["no workflow", { version: 1 }],
    ["an empty workflow", { workflowId: "", version: 1 }],
    ["a version that isn't one", { workflowId: "workflow-1", version: 0 }],
    ["a fractional version", { workflowId: "workflow-1", version: 1.5 }],
  ])("refuse a sealed pin with %s", (_case, sealed) => {
    expect(() =>
      readSealedWorkflows({
        summarizeNote: { alias: "summarizeNote", pinned: sealed },
      })
    ).toThrow(/pin/u);
  });

  test("are names alone, frozen all the way down", () => {
    const reference = workflows.summarizeNote;
    expect({
      keys: Object.keys(reference).toSorted(),
      name: reference.name,
      events: reference.events,
      decisions: reference.decisions,
    }).toStrictEqual({
      keys: ["decisions", "events", "mutations", "name", "queries"],
      name: "workflows.summarizeNote",
      events: {
        noteEdited: { name: "workflows.summarizeNote.events.noteEdited" },
        styleChosen: { name: "workflows.summarizeNote.events.styleChosen" },
      },
      decisions: {
        approveSummary: {
          name: "workflows.summarizeNote.decisions.approveSummary",
        },
        chooseLength: {
          name: "workflows.summarizeNote.decisions.chooseLength",
        },
      },
    });
    for (const each of Object.values(workflows)) {
      // Data all the way down: a clone refuses a function, and keeps all.
      expect(structuredClone(each)).toStrictEqual(each);
    }
    // No descriptor of the declaration's, or anything else, rides along.
    expect(JSON.stringify(workflows)).not.toContain("descriptorVersion");
    expect([
      Object.isFrozen(reference),
      Object.isFrozen(reference.events),
      Object.isFrozen(reference.events.noteEdited),
      Object.isFrozen(reference.decisions.approveSummary),
      Reflect.set(
        reference.events.noteEdited,
        "name",
        "workflows.archiveNotes.events.confirmed"
      ),
    ]).toStrictEqual([true, true, true, true, false]);
  });

  test("expose a run, whether one may start, runs, history, the decision inbox and a decision as queries, and starts, controls and sends as mutations, by name", async () => {
    const functions = Object.entries(workflows).flatMap(([alias, reference]) =>
      (["queries", "mutations"] as const).flatMap((group) =>
        Object.entries<AnyFunctionReference>(reference[group]).map(
          ([name, fn]) => ({
            path: `workflows.${alias}.${group}.${name}`,
            fn,
          })
        )
      )
    );
    expect(functions.map(({ path }) => path).toSorted()).toStrictEqual(
      ["archiveNotes", "summarizeNote"].flatMap((alias) => [
        ...["cancel", "pause", "resume", "send", "start"].map(
          (name) => `workflows.${alias}.mutations.${name}`
        ),
        ...["canStart", "decision", "decisions", "history", "run", "runs"].map(
          (name) => `workflows.${alias}.queries.${name}`
        ),
      ])
    );
    for (const { path, fn } of functions) {
      expect(fn.name).toBe(path);
    }
    // A workflow that asks nobody has no inbox, and no decision rows; one
    // that listens for nothing takes no event.
    const files = await generatedWith([], {
      archiveNotes: { events: {}, listens: {}, decisions: {} },
    });
    const text = files["server/_generated/api.ts"] ?? "";
    expect(text).toContain("workflows.archiveNotes.queries.history");
    expect(text).not.toContain("workflows.archiveNotes.queries.decision");
    expect(text).not.toContain("workflows.archiveNotes.mutations.send");
  });

  test("take only what each mutation declares: the workflow's args, a run, and an event it declares with that event's data", () => {
    const bound = declaredWorkflows(notesManifest(), []).find(
      ({ alias }) => alias === "summarizeNote"
    );
    if (bound === undefined) {
      throw new Error("The fixture declares summarizeNote");
    }
    const { mutations } = workflowFunctions(bound);
    const noteId = "01890000-0000-7000-8000-000000000001";
    const cases = {
      start: [mutations.start, { args: { noteId } }],
      "start: args the workflow doesn't take": [
        mutations.start,
        { args: { noteId: 1 } },
      ],
      cancel: [mutations.cancel, { runId: "run-1" }],
      "cancel: a field it doesn't take": [
        mutations.cancel,
        { runId: "run-1", workflow: "wf-1" },
      ],
      send: [
        mutations.send,
        { runId: "run-1", event: "styleChosen", data: { style: "short" } },
      ],
      "send: another event's data": [
        mutations.send,
        { runId: "run-1", event: "styleChosen", data: { noteId } },
      ],
      "send: an event it doesn't declare": [
        mutations.send,
        { runId: "run-1", event: "documentUploaded", data: {} },
      ],
      "send: an envelope's source": [
        mutations.send,
        {
          runId: "run-1",
          event: "styleChosen",
          data: { style: "short" },
          source: "urn:someone",
        },
      ],
    } as const;
    const accepted = Object.fromEntries(
      Object.entries(cases).map(([what, [fn, value]]) => [
        what,
        fn !== undefined &&
          schemaOf(fn.args)["~standard"].validate(value).issues === undefined,
      ])
    );
    expect(accepted).toStrictEqual({
      start: true,
      "start: args the workflow doesn't take": false,
      cancel: true,
      "cancel: a field it doesn't take": false,
      send: true,
      "send: another event's data": false,
      "send: an event it doesn't declare": false,
      "send: an envelope's source": false,
    });
  });

  test("hold as many decisions as a workflow declares, contexts nested one level short of the limit, and refuse deeper by name", async () => {
    const many = Object.fromEntries(
      Array.from({ length: workflowReferenceLimits.decisions }, (_, index) => [
        `decision${index}`,
        { value: v.null().descriptor, context: v.null().descriptor },
      ])
    );
    const deep = async (depth: number) =>
      await generatedWith([], {
        summarizeNote: {
          decisions: {
            deep: { value: v.null().descriptor, context: nested(depth) },
          },
        },
      });
    const files = await generatedWith([], {
      summarizeNote: { decisions: many },
    });
    expect(files["server/_generated/api.ts"]).toContain(
      `WorkflowDecisionDetail<"decision${workflowReferenceLimits.decisions - 1}"`
    );
    expect(
      pageBuildOf(files).workflows.get("summarizeNote")?.decisions.size
    ).toBe(workflowReferenceLimits.decisions);
    await expect(deep(valueLimits.depth - 1)).resolves.toBeDefined();
    await expect(deep(valueLimits.depth)).rejects.toThrow(
      "summarizeNote's contracts don't fit its generated functions"
    );
  });

  test("answer only what each query declares: declared keys, no result, a known context", () => {
    // What core checks each query's answer against, by the declaration.
    const bound = declaredWorkflows(notesManifest(), []).find(
      ({ alias }) => alias === "summarizeNote"
    );
    if (bound === undefined) {
      throw new Error("The fixture declares summarizeNote");
    }
    const { queries } = workflowFunctions(bound);
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
    const completed = {
      runId: "run-1",
      workflowId: "wf-1",
      workflowVersion: 2,
      manifestHash: "m",
      status: "completed",
      startedAt: 1000,
      finishedAt: 2000,
      waits: [],
      control: {
        canPause: false,
        canResume: false,
        canCancel: false,
        pendingControl: null,
      },
      result: { summary: "s", words: 1 },
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
      "history: a run's args": [
        queries.history,
        pageOf([{ ...historyRow, args: { noteId: "n" } }]),
      ],
      runs: [queries.runs, pageOf([runRow])],
      "runs: a run's result": [
        queries.runs,
        pageOf([{ ...runRow, result: { summary: "s" } }]),
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
      run: [queries.run, completed],
      "run: not seen": [queries.run, null],
      "run: a result the App doesn't declare": [
        queries.run,
        { ...completed, result: { summary: "s" } },
      ],
      "run: its args": [queries.run, { ...completed, args: { noteId: "n" } }],
      canStart: [queries.canStart, true],
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
      "history: a run's args": false,
      runs: true,
      "runs: a run's result": false,
      decision: true,
      "decision: closed": true,
      "decision: another decision's context": false,
      "decision: another decision's wait": false,
      run: true,
      "run: not seen": true,
      "run: a result the App doesn't declare": false,
      "run: its args": false,
      canStart: true,
    });
  });

  test("are covered by the release's contracts with all the App declares of them, and the version each binding pinned", async () => {
    const text = v.string().descriptor;
    const edited = summarizeNote.events.noteEdited;
    const approve = summarizeNote.decisions.approveSummary;
    if (edited === undefined || approve === undefined) {
      throw new Error("The fixture declares noteEdited and approveSummary");
    }
    const declarationChanges: DeclaredChange[] = [
      { args: text },
      { returns: text },
      {
        events: {
          ...summarizeNote.events,
          noteEdited: { ...edited, data: text },
        },
      },
      {
        events: {
          ...summarizeNote.events,
          noteEdited: { ...edited, type: "notes.note.changed" },
        },
      },
      {
        events: { ...summarizeNote.events, extra: { type: "x", data: text } },
      },
      { listens: { "do/0/chooseStyle": ["styleChosen"] } },
      {
        decisions: {
          ...summarizeNote.decisions,
          approveSummary: { ...approve, value: text },
        },
      },
      {
        decisions: {
          ...summarizeNote.decisions,
          approveSummary: { ...approve, context: text },
        },
      },
      { decisions: {} },
    ];
    const generated = await Promise.all([
      generatedWith([]),
      generatedWith([{ alias: "summarizeNote", pinned }]),
      generatedWith([
        { alias: "summarizeNote", pinned: { ...pinned, version: 4 } },
      ]),
      ...declarationChanges.map(
        async (change) => await generatedWith([], { summarizeNote: change })
      ),
    ]);
    const contracts = generated.map((files) => files[".grasp/contracts.json"]);
    expect(new Set(contracts).size).toBe(contracts.length);
    // And what the host compares before a page follows a run another
    // release started changes with each change of the declaration.
    const prints = await Promise.all(
      [{}, ...declarationChanges].map(
        async (change) =>
          await workflowFingerprint({ ...summarizeNote, ...change })
      )
    );
    expect(new Set(prints).size).toBe(prints.length);
  });

  test("are the same bytes whatever order the bindings, the events and the listen tasks come in", async () => {
    const pins: WorkflowBindingExtras[] = [
      {
        alias: "archiveNotes",
        pinned: { workflowId: "workflow-2", version: 1 },
      },
      { alias: "summarizeNote", pinned },
    ];
    const reversed = changed((data) => {
      const declared = ["permissions", "summarizeNote"];
      const events = at(data, [...declared, "events"]);
      setAt(
        data,
        [...declared, "events"],
        Object.fromEntries(
          Object.entries(isPlainObject(events) ? events : {}).toReversed()
        )
      );
      const listens = at(data, [...declared, "listens"]);
      setAt(
        data,
        [...declared, "listens"],
        Object.fromEntries(
          Object.entries(isPlainObject(listens) ? listens : {}).toReversed()
        )
      );
    });
    await expect(
      generateModules(readAppManifest(reversed), pins.toReversed())
    ).resolves.toStrictEqual(await generateModules(notesManifest(), pins));
  });

  test("hold exactly as many events as the client reads (workflowReferenceLimits)", async () => {
    const files = await generatedWith([], {
      summarizeNote: {
        events: Object.fromEntries(
          Array.from({ length: workflowReferenceLimits.events }, (_, index) => [
            `event${index}`,
            { type: "x", data: v.null().descriptor },
          ])
        ),
        listens: {},
      },
    });
    expect(files["server/_generated/api.ts"]).toContain(
      `workflows.summarizeNote.events.event${workflowReferenceLimits.events - 1}`
    );
    expect(pageBuildOf(files).workflows.get("summarizeNote")?.events.size).toBe(
      workflowReferenceLimits.events
    );
  });

  test("are made for every workflow the App declares, with the contract it declares, whatever the host resolved of it", async () => {
    const files = await generatedWith([]);
    const build = pageBuildOf(files);
    expect({
      references: ["archiveNotes", "summarizeNote"].map((alias) =>
        (files["server/_generated/api.ts"] ?? "").includes(
          `"name": "workflows.${alias}"`
        )
      ),
      sealed: at(JSON.parse(files[".grasp/contracts.json"] ?? "{}"), [
        "workflows",
      ]),
      events: [...(build.workflows.get("archiveNotes")?.events ?? [])],
      decisions: [...(build.workflows.get("archiveNotes")?.decisions ?? [])],
    }).toStrictEqual({
      references: [true, true],
      sealed: {},
      events: Object.entries(archiveNotes.events),
      decisions: Object.entries(archiveNotes.decisions),
    });
  });

  test.each<[string, readonly WorkflowBindingExtras[]]>([
    [
      "the same alias twice",
      [
        { alias: "summarizeNote", pinned },
        { alias: "summarizeNote", pinned: { ...pinned, version: 4 } },
      ],
    ],
    [
      "a workflow the App doesn't declare",
      [{ alias: "translateNote", pinned }],
    ],
    ["an alias that isn't plain", [{ alias: "summarize-note", pinned }]],
    ["an inherited key", [{ alias: "constructor", pinned }]],
    ["another kind's permission", [{ alias: "files", pinned }]],
  ])("refuse a binding of %s", async (_what, bound) => {
    await expect(generatedWith(bound)).rejects.toThrow(TypeError);
  });
});

/** `count` entries of `entry`, each under its own plain name. */
const entries = (count: number, entry: unknown) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`entry${index}`, entry])
  );

describe("a workflow's declaration", () => {
  // SAFETY: a deliberately ill-typed view, for declarations the types refuse.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const looseWorkflow = permission.workflow as (
    alias: string,
    config: unknown
  ) => unknown;
  const declaredEvent = { type: "notes.note.edited", data: v.null() };
  const declaredDecision = { value: v.null(), context: v.null() };

  test("holds its events, listens and decisions as data, each listen's events in name order", () => {
    const declared = permission.workflow("review", {
      args: v.object({}),
      returns: v.null(),
      events: { edited: declaredEvent, approved: declaredEvent },
      listens: { "do/0/wait": ["edited", "approved"] },
      decisions: { sign: declaredDecision },
    });
    expect({
      events: declared.events,
      listens: declared.listens,
      decisions: declared.decisions,
    }).toStrictEqual({
      events: {
        edited: { type: "notes.note.edited", data: v.null().descriptor },
        approved: { type: "notes.note.edited", data: v.null().descriptor },
      },
      listens: { "do/0/wait": ["approved", "edited"] },
      decisions: {
        sign: { value: v.null().descriptor, context: v.null().descriptor },
      },
    });
  });

  test.each<[string, Record<string, unknown>, string]>([
    [
      "an event type that is empty",
      { events: { edited: { ...declaredEvent, type: "" } } },
      "type is 1 to",
    ],
    [
      "an event type with a control character inside",
      { events: { edited: { ...declaredEvent, type: "note\tedited" } } },
      "type is 1 to",
    ],
    [
      "an event type with a space at its end",
      { events: { edited: { ...declaredEvent, type: "note.edited " } } },
      "type is 1 to",
    ],
    [
      "an event type longer than a run's inbox takes",
      {
        events: {
          edited: {
            ...declaredEvent,
            type: "t".repeat(sealedBuildLimits.eventTypeLength + 1),
          },
        },
      },
      "type is 1 to",
    ],
    [
      "an event type that isn't text",
      { events: { edited: { ...declaredEvent, type: 7 } } },
      "type is 1 to",
    ],
    [
      "a listen naming an event it doesn't declare",
      {
        events: { edited: declaredEvent },
        listens: { "do/0/wait": ["uploaded"] },
      },
      "listens for events the workflow declares, each once",
    ],
    [
      "a listen naming an inherited key",
      {
        events: { edited: declaredEvent },
        listens: { "do/0/wait": ["constructor"] },
      },
      "listens for events the workflow declares, each once",
    ],
    [
      "a listen naming one event twice",
      {
        events: { edited: declaredEvent },
        listens: { "do/0/wait": ["edited", "edited"] },
      },
      "listens for events the workflow declares, each once",
    ],
    [
      "a listen naming no event",
      { events: { edited: declaredEvent }, listens: { "do/0/wait": [] } },
      "listens for events the workflow declares, each once",
    ],
    [
      "a listen naming its event as text, not a list",
      { events: { edited: declaredEvent }, listens: { "do/0/wait": "edited" } },
      "listens for events the workflow declares, each once",
    ],
    [
      "a listen task with no path",
      { events: { edited: declaredEvent }, listens: { "": ["edited"] } },
      "listens for events the workflow declares, each once",
    ],
    [
      "a listen task's path longer than a run's waits take",
      {
        events: { edited: declaredEvent },
        listens: {
          ["t".repeat(workflowReferenceLimits.taskPathLength + 1)]: ["edited"],
        },
      },
      "listens for events the workflow declares, each once",
    ],
    [
      "an event alias that isn't plain",
      { events: { "note edited": declaredEvent } },
      "isn't an event's or a decision's alias",
    ],
    [
      "an event under the prototype's key",
      { events: Object.fromEntries([["__proto__", declaredEvent]]) },
      "isn't an event's or a decision's alias",
    ],
    [
      "a decision alias that isn't plain",
      { decisions: { "approve summary": declaredDecision } },
      "isn't an event's or a decision's alias",
    ],
    [
      "more events than a workflow holds",
      { events: entries(workflowReferenceLimits.events + 1, declaredEvent) },
      `at most ${workflowReferenceLimits.events} events`,
    ],
    [
      "more decisions than a workflow holds",
      {
        decisions: entries(
          workflowReferenceLimits.decisions + 1,
          declaredDecision
        ),
      },
      `at most ${workflowReferenceLimits.decisions} decisions`,
    ],
    [
      "more listen tasks than a workflow holds",
      {
        events: { edited: declaredEvent },
        listens: entries(workflowReferenceLimits.listens + 1, ["edited"]),
      },
      `at most ${workflowReferenceLimits.listens} listen tasks`,
    ],
    [
      "events that aren't a record",
      { events: [declaredEvent] },
      "`events` is an object",
    ],
    [
      "an event with a key it doesn't take",
      { events: { edited: { ...declaredEvent, fingerprint: "f".repeat(64) } } },
      "has no `fingerprint`",
    ],
    [
      "a decision with a key it doesn't take",
      {
        decisions: {
          sign: { ...declaredDecision, valueSchema: v.null().descriptor },
        },
      },
      "has no `valueSchema`",
    ],
    [
      "an event whose data is a descriptor, not a schema",
      { events: { edited: { ...declaredEvent, data: v.null().descriptor } } },
      "`v` schemas",
    ],
    [
      "a decision without its context",
      { decisions: { sign: { value: v.null() } } },
      "`v` schemas",
    ],
  ])("refuses %s", (_case, config, message) => {
    expect(
      refusal(() =>
        looseWorkflow("review", {
          args: v.object({}),
          returns: v.null(),
          ...config,
        })
      )
    ).toContain(message);
  });

  test.each<[string, (data: unknown) => void, string]>([
    [
      "an event type that isn't one",
      (data) => {
        setAt(
          data,
          ["permissions", "summarizeNote", "events", "noteEdited", "type"],
          "note\tedited"
        );
      },
      "type is 1 to",
    ],
    [
      "a listen naming an event it doesn't declare",
      (data) => {
        setAt(
          data,
          ["permissions", "summarizeNote", "listens", "do/0/chooseStyle"],
          ["confirmed"]
        );
      },
      "listens for events the workflow declares, each once",
    ],
    [
      "a listen naming one event twice",
      (data) => {
        setAt(
          data,
          ["permissions", "summarizeNote", "listens", "do/0/chooseStyle"],
          ["styleChosen", "styleChosen"]
        );
      },
      "listens for events the workflow declares, each once",
    ],
    [
      "a listen's events out of the order its declaration keeps",
      (data) => {
        setAt(
          data,
          ["permissions", "summarizeNote", "listens", "do/2/awaitEdit"],
          ["styleChosen", "noteEdited"]
        );
      },
      "isn't what its declaration makes",
    ],
    [
      "an event alias that isn't plain",
      (data) => {
        setAt(
          data,
          ["permissions", "summarizeNote", "events", "note edited"],
          at(data, ["permissions", "summarizeNote", "events", "noteEdited"])
        );
      },
      "isn't an event's or a decision's alias",
    ],
    [
      "more events than a workflow holds",
      (data) => {
        setAt(
          data,
          ["permissions", "summarizeNote", "events"],
          entries(workflowReferenceLimits.events + 1, {
            type: "x",
            data: v.null().descriptor,
          })
        );
        setAt(data, ["permissions", "summarizeNote", "listens"], {});
      },
      "at most 64 events",
    ],
    [
      "an event's own fingerprint",
      (data) => {
        setAt(
          data,
          [
            "permissions",
            "summarizeNote",
            "events",
            "noteEdited",
            "fingerprint",
          ],
          "f".repeat(64)
        );
      },
      "has no `fingerprint`",
    ],
    [
      "a decision's own value schema",
      (data) => {
        setAt(
          data,
          [
            "permissions",
            "summarizeNote",
            "decisions",
            "chooseLength",
            "valueSchema",
          ],
          { kind: "descriptor", descriptor: v.null().descriptor }
        );
      },
      "has no `valueSchema`",
    ],
    [
      "a decision without its context",
      (data) => {
        removeAt(data, [
          "permissions",
          "summarizeNote",
          "decisions",
          "chooseLength",
          "context",
        ]);
      },
      "A descriptor is a JSON object",
    ],
    [
      "an event's data of a kind there isn't",
      (data) => {
        setAt(
          data,
          [
            "permissions",
            "summarizeNote",
            "events",
            "noteEdited",
            "data",
            "kind",
          ],
          "script"
        );
      },
      "kind isn't one this SDK knows",
    ],
    [
      "a release's identity on the workflow",
      (data) => {
        setAt(
          data,
          ["permissions", "summarizeNote", "resourceId"],
          "app_0000000000000000000000notes"
        );
      },
      "has no `resourceId`",
    ],
  ])("refuses %s in a manifest read back", (_case, change, message) => {
    const text = changed(change);
    expect(refusal(() => readAppManifest(text))).toContain(message);
  });
});

describe("symbolic references", () => {
  test("resolve against the registration by path, and never survive into generated modules", () => {
    const modules = symbolicModules();
    expect(Object.keys(modules).toSorted()).toStrictEqual([
      ".grasp/functions.ts",
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
    const channel: FunctionChannel = {
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
