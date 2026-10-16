import { fileLimits } from "@grasp-os/shared/app-file-limits";
import { describe, expect, test } from "vite-plus/test";

import {
  contractFingerprint,
  decisionFingerprint,
  eventFingerprint,
  generateModules,
  inspectApp,
  readAppManifest,
  symbolicModules,
  workflowFingerprint,
} from "../src/host.ts";
import type {
  AppManifest,
  BoundWorkflow,
  WorkflowBindingExtras,
} from "../src/host.ts";
import type { AnyOperationReference } from "../src/index.ts";
import { app, resource, v } from "../src/index.ts";
import { workflowReferenceLimits } from "../src/references.ts";
import { runFunction } from "../src/runner.ts";
import type { OperationChannel } from "../src/runner.ts";
import { serverModule } from "../src/server.ts";
import { valueLimits } from "../src/value-descriptor.ts";
import { schemaOf } from "../src/value-schema.ts";
import type { AnySchema } from "../src/value-schema.ts";
import { defineSchema, defineTable } from "../src/values.ts";
import { notesWorkflows } from "./notes-workflows.ts";
import contractsText from "./notes/.grasp/contracts.json?raw";
// oxlint-disable-next-line import/default -- a ?raw import is the file's text
import referencesText from "./notes/.grasp/references.ts?raw";
import {
  api,
  preferences,
  resources,
  screens,
  workflows,
} from "./notes/.grasp/references.ts";
// oxlint-disable-next-line import/default -- a ?raw import is the file's text
import serverReferencesText from "./notes/.grasp/server-references.ts?raw";
import { internal } from "./notes/.grasp/server-references.ts";
// oxlint-disable-next-line import/default -- a ?raw import is the file's text
import serverText from "./notes/.grasp/server.ts?raw";
import notes, { archiveNotes, summarizeNote } from "./notes/app.ts";

// References and generated modules (spec 7.3, 8, 32.1), and reading an
// App's manifest back as the host does: pure logic, so unit tests. The
// Notes fixture (test/notes) is an App as the product lays it out, and
// its `.grasp/` is what the host generates for it: the first test fails
// whenever the generator or the fixture changes without the other.
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
      ".grasp/server.ts": serverText,
      ".grasp/server-references.ts": serverReferencesText,
      ".grasp/references.ts": referencesText,
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

  test("pin each function's exact contract, which any change to it changes", async () => {
    const manifest = notesManifest();
    const create = manifest.operations["notes.create"];
    if (create === undefined) {
      throw new Error("No notes.create");
    }
    expect(api.notes.create.fingerprint).toBe(
      await contractFingerprint(create)
    );
    const changes = [
      { ...create, kind: "action" as const },
      { ...create, visibility: "internal" as const },
      { ...create, returns: v.string().descriptor },
      { ...create, stream: v.null().descriptor },
    ];
    for (const change of changes) {
      // One after the other: each is compared with the original.
      // oxlint-disable-next-line no-await-in-loop -- see above
      await expect(contractFingerprint(change)).resolves.not.toBe(
        api.notes.create.fingerprint
      );
    }
  });

  test("hold data only: the 32.1 keys, frozen all the way down", () => {
    expect(Object.keys(api.notes.create).toSorted()).toStrictEqual(
      [
        "args",
        "contractId",
        "fingerprint",
        "kind",
        "mode",
        "resourceId",
        "resourceVersion",
        "returns",
        "visibility",
      ].toSorted()
    );
    // The phantom types exist in types only.
    expect(Object.getOwnPropertySymbols(api.notes.create)).toStrictEqual([]);
    expect(textOf(api.notes.create)).toBe(textOf({ ...api.notes.create }));
    expect([
      Object.isFrozen(api),
      Object.isFrozen(api.notes),
      Object.isFrozen(api.notes.create.args),
      Object.isFrozen(resources.attachments.operations),
      Object.isFrozen(screens.note.input),
    ]).toStrictEqual([true, true, true, true, true]);
    expect(
      Reflect.set(api.notes.create, "contractId", "notes.remove")
    ).toBeFalsy();
  });

  test("give a streaming action stream mode and its progress descriptor, and no other function either", () => {
    expect([
      api.notes.exportAll.mode,
      api.notes.exportAll.stream,
    ]).toStrictEqual([
      "stream",
      v.object({ done: v.number().integer().min(0) }).descriptor,
    ]);
    expect([api.notes.create.mode, "stream" in api.notes.create]).toStrictEqual(
      ["single", false]
    );
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
    expect(internal.notes.count).toMatchObject({
      contractId: "notes.count",
      visibility: "internal",
      kind: "query",
    });
    expect(referencesText).not.toContain("notes.count");
  });

  test("keep handlers, schemas and server modules out of what a browser imports", () => {
    for (const forbidden of [
      "handler",
      "schema.ts",
      "@grasp-os/sdk/server",
      "serverModule",
      "operations/",
      "internal",
    ]) {
      expect(referencesText).not.toContain(forbidden);
    }
  });

  test("expose the screens' resources with their literal operations and origins, and only those", () => {
    expect(resources).toStrictEqual({
      attachments: {
        kind: "files",
        alias: "attachments",
        operations: ["upload", "read", "attach"],
      },
      help: {
        kind: "links",
        alias: "help",
        origins: ["https://help.example.com"],
      },
    });
  });

  test("give each screen its route and the input its parameters are validated with", () => {
    expect(screens).toStrictEqual({
      notes: {
        name: "notes",
        path: "/",
        input: v.object({}).descriptor,
      },
      note: {
        name: "note",
        path: "/notes/:id",
        input: v.object({ id: v.id("notes") }).descriptor,
      },
    });
  });

  test("export preferences only when the App declares them", async () => {
    expect(preferences.descriptor).toStrictEqual(
      v.object({ compact: v.boolean().default(false) }).descriptor
    );
    const manifest = readAppManifest(
      changed((data) => {
        setAt(data, ["preferences"], null);
      })
    );
    const files = await generateModules(manifest, identity);
    expect(files[".grasp/references.ts"]).not.toContain("preferences");
  });

  test("export no workflows for an App that declares none", async () => {
    const files = await generateModules(
      { ...notesManifest(), workflows: {} },
      identity
    );
    expect(files[".grasp/references.ts"]).toContain(
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
            workflows: {
              ...manifest.workflows,
              summarizeNote: { ...summarizeNote, ...declared },
            },
          },
      identity,
      bound
    );
  };

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

  test("expose runs, history, the decision inbox and a decision as public query references of their own contracts", async () => {
    const queries = Object.entries(workflows).flatMap(([alias, reference]) =>
      Object.entries<AnyOperationReference>(reference.queries).map(
        ([name, query]) => ({
          name,
          query,
          manifest: {
            path: `workflows.${alias}.queries.${name}`,
            kind: "query" as const,
            visibility: "public" as const,
            args: query.args,
            returns: query.returns,
            stream: null,
            uses: [],
            tables: {},
          },
        })
      )
    );
    expect(
      queries.map(({ manifest }) => manifest.path).toSorted()
    ).toStrictEqual(
      ["archiveNotes", "summarizeNote"].flatMap((alias) =>
        ["decision", "decisions", "history", "runs"].map(
          (name) => `workflows.${alias}.queries.${name}`
        )
      )
    );
    const fingerprints = await Promise.all(
      queries.map(async ({ manifest }) => await contractFingerprint(manifest))
    );
    for (const [index, { query, manifest }] of queries.entries()) {
      expect(query).toMatchObject({
        ...identity,
        contractId: manifest.path,
        kind: "query",
        visibility: "public",
        mode: "single",
        fingerprint: fingerprints[index],
      });
    }
    // A workflow that asks nobody has no inbox, and no decision rows.
    const files = await generatedWith([
      { alias: "archiveNotes", events: {}, listens: {}, decisions: {} },
    ]);
    const text = files[".grasp/references.ts"] ?? "";
    expect(text).toContain("workflows.archiveNotes.queries.history");
    expect(text).not.toContain("workflows.archiveNotes.queries.decision");
  });

  test("hold as many decisions as a reference does, contexts nested one level short of the limit, and refuse deeper by name", async () => {
    const many: BoundWorkflow = {
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
    const deep = (depth: number): BoundWorkflow => ({
      ...summarize,
      decisions: {
        deep: { value: v.null().descriptor, context: nested(depth) },
      },
    });
    const files = await generatedWith([many]);
    expect(files[".grasp/references.ts"]).toContain(
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
    const { queries } = workflows.summarizeNote;
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
    expect(files[".grasp/references.ts"]).toContain(
      `event${workflowReferenceLimits.events - 1}`
    );
  });

  test("are made for every workflow the App declares, with the contract it declares, whatever the host resolved of it", async () => {
    const files = await generatedWith([]);
    const references = files[".grasp/references.ts"] ?? "";
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
              type: "t".repeat(workflowReferenceLimits.eventTypeLength + 1),
              data: v.null().descriptor,
            },
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
      ".grasp/references.ts",
      ".grasp/server-references.ts",
    ]);
    expect(Object.values(modules).join("\n")).toContain("new Proxy");
    expect([referencesText, serverReferencesText].join("\n")).not.toContain(
      "Proxy"
    );
  });
});

const schema = defineSchema({
  notes: defineTable({ title: v.string() }),
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
const looseApp = app as (definition: unknown) => unknown;
// SAFETY: as above.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const looseAction = server.action as (declaration: unknown) => unknown;
// SAFETY: as above.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const looseMutation = server.mutation as (declaration: unknown) => unknown;
// SAFETY: as above.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const looseResource = resource as Record<
  "files" | "links",
  (alias: unknown, config: unknown) => unknown
>;

/** A small App, with `changes` to its registration. */
/** `count` files resources that may be attached. */
const attachables = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    resource.files(`files${index}`, { operations: ["read", "attach"] })
  );

const small = (changes: Record<string, unknown> = {}) =>
  looseApp({
    name: "Small",
    schema,
    access: { tables: { notes: { read: "appMembers" } } },
    operations: { notes: { list, send } },
    internalOperations: { notes: { secret } },
    screens: [],
    uses: [],
    ...changes,
  });

describe("references in uses", () => {
  test("name a registered function by its path, matching its visibility and kind", () => {
    // A reference is data: one written by hand names what a generated one
    // would.
    const tally = looseAction({
      args: {},
      returns: v.number(),
      uses: [
        { contractId: "notes.secret", visibility: "internal", kind: "query" },
      ],
      handler: () => 1,
    });
    const { manifest } = inspectApp(
      small({ operations: { notes: { list, send, tally } } })
    );
    expect(manifest.operations["notes.tally"]?.uses).toStrictEqual([
      { type: "function", path: "notes.secret", kind: "query" },
    ]);
  });

  test.each([
    [
      "another kind than what is registered there",
      { contractId: "notes.secret", visibility: "internal", kind: "mutation" },
      "doesn't match what is registered there",
    ],
    [
      "another visibility",
      { contractId: "notes.secret", visibility: "public", kind: "query" },
      "doesn't match what is registered there",
    ],
    [
      "a path nothing is registered at",
      { contractId: "notes.missing", visibility: "internal", kind: "query" },
      "doesn't register",
    ],
  ])("with %s are refused", (_case, reference, message) => {
    const tally = looseAction({
      args: {},
      returns: v.number(),
      uses: [reference],
      handler: () => 1,
    });
    expect(
      refusal(() => small({ operations: { notes: { list, send, tally } } }))
    ).toContain(message);
  });

  test("let a symbolic reference take its kind from the registration, and hold a mutation to queries", () => {
    const symbolic = { contractId: "notes.send", visibility: "public" };
    const change = looseMutation({
      args: {},
      returns: v.null(),
      uses: [symbolic],
      handler: () => null,
    });
    expect(
      refusal(() => small({ operations: { notes: { list, send, change } } }))
    ).toContain("it may run the App's queries, never `notes.send`, a action");
  });

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
    };
    await expect(runFunction(notes, "notes.tally", {}, channel)).resolves.toBe(
      3
    );
    expect(calls).toStrictEqual([["query", reference.contractId, {}]]);
  });
});

describe("reserved segments", () => {
  test.each(["contractId", "visibility", "kind", "then"])(
    "no function registers at a segment named %s, at any depth",
    (name) => {
      expect(
        refusal(() => small({ operations: { notes: { list, [name]: send } } }))
      ).toContain("is a name a reference itself answers");
      expect(
        refusal(() => small({ operations: { [name]: { list } } }))
      ).toContain("is a name a reference itself answers");
    }
  );
});

describe("screens and preferences", () => {
  test.each([
    ["a map instead of a list", {}, "is a list"],
    [
      "a route that doesn't start with /",
      [{ name: "a", path: "notes", source: "screens/a.tsx" }],
      "starting with `/`",
    ],
    [
      "a segment that is neither a name nor a parameter",
      [{ name: "a", path: "/Notes", source: "screens/a.tsx" }],
      "neither a lower-case name",
    ],
    [
      "two routes that differ only in a parameter's name",
      [
        {
          name: "a",
          path: "/n/:id",
          source: "screens/a.tsx",
          input: v.object({ id: v.string() }),
        },
        {
          name: "b",
          path: "/n/:key",
          source: "screens/b.tsx",
          input: v.object({ key: v.string() }),
        },
      ],
      "Two screens have route",
    ],
    [
      "a parameter without input",
      [{ name: "a", path: "/n/:id", source: "screens/a.tsx" }],
      "declare its `input`",
    ],
    [
      "a parameter whose field is nullable",
      [
        {
          name: "a",
          path: "/n/:id",
          source: "screens/a.tsx",
          input: v.object({ id: v.id("notes").nullable() }),
        },
      ],
      "no required string, ID or enum field `id`",
    ],
    [
      "a parameter whose field isn't a string",
      [
        {
          name: "a",
          path: "/n/:id",
          source: "screens/a.tsx",
          input: v.object({ id: v.number() }),
        },
      ],
      "no required string, ID or enum field `id`",
    ],
    [
      "a source outside screens/",
      [{ name: "a", path: "/", source: "operations/a.tsx" }],
      "`screens/<file>.tsx`",
    ],
    [
      "a name that isn't an identifier",
      [{ name: "a-b", path: "/", source: "screens/a.tsx" }],
      "is an identifier",
    ],
    [
      "two screens of one name",
      [
        { name: "a", path: "/", source: "screens/a.tsx" },
        { name: "a", path: "/b", source: "screens/b.tsx" },
      ],
      "Two screens are named",
    ],
    [
      "a key no screen has",
      [{ name: "a", path: "/", source: "screens/a.tsx", component: "A" }],
      "`{ name, path, source, input? }`",
    ],
  ])("with %s are refused", (_case, screensDeclared, message) => {
    expect(refusal(() => small({ screens: screensDeclared }))).toContain(
      message
    );
  });

  test.each([
    ["a value that isn't an object", v.boolean()],
    ["a nullable object", v.object({ compact: v.boolean() }).nullable()],
  ])("preferences that are %s are refused", (_case, declared) => {
    expect(refusal(() => small({ preferences: declared }))).toContain(
      "is a required `v.object`"
    );
  });

  test.each([
    ["public", { operations: { preferences: { list } } }],
    ["internal", { internalOperations: { preferences: { secret } } }],
  ])(
    "no %s function registers under the preferences segment",
    (_case, changes) => {
      expect(refusal(() => small(changes))).toContain(
        "that path is the platform's"
      );
    }
  );
});

describe("browser resources", () => {
  test.each([
    ["plain HTTP", ["http://help.example.com"]],
    ["a path", ["https://help.example.com/docs"]],
    ["upper case", ["https://Help.example.com"]],
    ["a wildcard", ["https://*.example.com"]],
    ["credentials", ["https://user@help.example.com"]],
    ["a trailing slash", ["https://help.example.com/"]],
    ["no origin at all", []],
  ])("links with %s are refused", (_case, origins) => {
    expect(() => looseResource.links("help", { origins })).toThrow(/origin/u);
  });

  test.each([
    ["an IPv6 address", "https://[2001:db8::1]"],
    ["an IPv6 address and a port", "https://[2001:db8::1]:8443"],
    ["an IPv4 address", "https://192.0.2.1"],
  ])("links accept %s as an exact origin", (_case, origin) => {
    expect(resource.links("help", { origins: [origin] }).origins).toStrictEqual(
      [origin]
    );
  });

  test.each([
    [
      "an IPv6 address not as the URL standard writes it",
      "https://[2001:DB8:0::1]",
    ],
    ["an IPv6 address with a path", "https://[2001:db8::1]/docs"],
  ])("links with %s are refused too", (_case, origin) => {
    expect(() => looseResource.links("help", { origins: [origin] })).toThrow(
      /origin/u
    );
  });

  test("files list only the operations there are, each once", () => {
    expect(() =>
      looseResource.files("attachments", { operations: ["upload", "share"] })
    ).toThrow(/can't have/u);
    expect(() =>
      looseResource.files("attachments", { operations: ["read", "read"] })
    ).toThrow(/twice/u);
  });

  test("share one namespace of aliases with the actions' resources", () => {
    const files = resource.files("help", { operations: ["read"] });
    const knowledge = resource.knowledge("help", {
      operations: ["search"],
      collections: ["handbook"],
    });
    expect(refusal(() => small({ uses: [files, knowledge] }))).toContain(
      "Two of the App's resources have alias `help`"
    );
  });

  test("number at most what a mutation hands core as attachable", () => {
    expect(() =>
      small({ uses: attachables(fileLimits.resources) })
    ).not.toThrow();
    expect(
      refusal(() => small({ uses: attachables(fileLimits.resources + 1) }))
    ).toContain(`at most ${fileLimits.resources} files resources`);
  });

  test("are never listed by a function", () => {
    const files = resource.files("attachments", { operations: ["read"] });
    expect(() =>
      looseAction({
        args: {},
        returns: v.null(),
        uses: [files],
        handler: () => null,
      })
    ).toThrow(/never IDs or names/u);
  });
});

describe("reading a manifest back", () => {
  test("gives exactly the manifest inspection made", () => {
    const manifest = notesManifest();
    expect(readAppManifest(textOf(manifest))).toStrictEqual(manifest);
  });

  test.each([
    [
      "a verb past the App's mode",
      (data: unknown) => {
        setAt(data, ["schema", "tables", "notes", "access", "write"], "none");
      },
      "widens access",
    ],
    [
      "an action given tables",
      (data: unknown) => {
        setAt(
          data,
          ["operations", "notes.tally", "tables", "notes", "read"],
          true
        );
      },
      "an action has no tables",
    ],
    [
      "a query that writes",
      (data: unknown) => {
        setAt(
          data,
          ["operations", "notes.get", "tables", "notes", "insert"],
          true
        );
      },
      "a query only reads",
    ],
    [
      "a mutation running an action",
      (data: unknown) => {
        setAt(
          data,
          ["operations", "notes.create", "uses"],
          [{ type: "function", path: "notes.tally", kind: "action" }]
        );
      },
      "it may run the App's queries",
    ],
    [
      "a use whose kind isn't the registered one",
      (data: unknown) => {
        setAt(
          data,
          ["operations", "notes.tally", "uses", 0, "kind"],
          "mutation"
        );
      },
      "doesn't match what is registered there",
    ],
    [
      "a use of something unregistered",
      (data: unknown) => {
        setAt(
          data,
          ["operations", "notes.tally", "uses", 0, "path"],
          "notes.missing"
        );
      },
      "never IDs or names",
    ],
    [
      "a resource a function uses that the App doesn't declare",
      (data: unknown) => {
        setAt(data, ["operations", "notes.tally", "uses", 1], {
          type: "resource",
          kind: "model",
          alias: "writer",
        });
      },
      "doesn't declare",
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
        setAt(data, ["operations", "notes"], {
          ...(typeof get === "object" ? get : {}),
          path: "notes",
        });
      },
      "clashes with another registered path",
    ],
    [
      "an action's resource filed as a screens' one",
      (data: unknown) => {
        setAt(
          data,
          ["resources", "help"],
          at(data, ["browserResources", "help"])
        );
        removeAt(data, ["browserResources", "help"]);
      },
      "isn't an action's resource",
    ],
    [
      "a resource filed under another alias",
      (data: unknown) => {
        setAt(
          data,
          ["browserResources", "manual"],
          at(data, ["browserResources", "help"])
        );
        removeAt(data, ["browserResources", "help"]);
      },
      "filed under its alias",
    ],
    [
      "a link origin that isn't exact",
      (data: unknown) => {
        setAt(
          data,
          ["browserResources", "help", "origins"],
          ["https://example.com/a"]
        );
      },
      "exact HTTPS origin",
    ],
    [
      "a screen filed under another name",
      (data: unknown) => {
        setAt(data, ["screens", "note", "name"], "other");
      },
      "filed under another name",
    ],
    [
      "nullable preferences",
      (data: unknown) => {
        setAt(data, ["preferences", "nullable"], true);
      },
      "is a required `v.object`",
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
      "Only an action streams",
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
