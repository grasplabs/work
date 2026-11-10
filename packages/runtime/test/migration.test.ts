import { describe, expect, test } from "vite-plus/test";

import { inspectApp, readAppManifest, registerApp } from "../src/host.ts";
import { defineApp, defineMigration } from "../src/index.ts";
import { runMigration } from "../src/runner.ts";
import { defineSchema, defineTable, v } from "../src/values.ts";

// How an App declares an explicit migration (spec 17.2), what its manifest
// records of it, and how the runner calls its handler: pure checks of a
// declaration and of the runner, so unit tests. That the host runs it in a
// capability-free sandbox and validates what it answers is tested through
// the host (apps/core/test/migration-run.test.ts).

const fromSchema = "a".repeat(64);
const toSchema = "b".repeat(64);

const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
  category: v.string().default("general"),
};

const schema = defineSchema({
  notes: defineTable(noteFields).access({ read: "owner", write: "owner" }),
});

const deriveCategory = defineMigration({
  name: "derive-note-category",
  fromSchema,
  toSchema,
  table: "notes",
  input: v.object({ title: noteFields.title, body: noteFields.body }),
  output: v.object(noteFields),
  fixtures: [
    {
      row: { title: "Plan", body: "Launch day" },
      expect: { title: "Plan", body: "Launch day", category: "launch" },
    },
    { row: { title: "Idea" } },
  ],
  handler: (ctx, row) => ({
    ...row,
    category: row.body.toLowerCase().includes("launch")
      ? "launch"
      : `general:${ctx.id}`,
  }),
});

/** Notes registered with `migrations`, and no server functions. */
const notes = (migrations: readonly unknown[]): unknown =>
  registerApp({
    config: defineApp({ name: "Notes" }),
    schema,
    modules: {},
    migrations,
  });

// SAFETY: deliberately loose, for declarations the types refuse.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const looseMigration = defineMigration as (definition: unknown) => unknown;

const declaration = {
  name: "derive-note-category",
  fromSchema,
  toSchema,
  table: "notes",
  output: v.object(noteFields),
  fixtures: [{ row: { title: "Note" } }],
  handler: (_ctx: unknown, row: unknown) => row,
};

/** One fixture's place, and nothing in it: `new Array(1)`. */
const onlyHole: unknown[] = [];
onlyHole.length = 1;

/** Fixtures with a hole between two fixtures: `map` would skip it. */
const holeyFixtures: unknown[] = [{ row: { title: "One" } }];
holeyFixtures[2] = { row: { title: "Three" } };

/** A row whose own key is `__proto__`, as JSON text can make one. */
const prototypeRow: unknown = JSON.parse('{"__proto__": {"x": 1}}');

/** `count` fixtures of a note each. */
const manyFixtures = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    row: { title: `Note ${index}` },
  }));

describe("a migration's declaration", () => {
  test.each([
    ["a name that isn't kebab-case", { name: "Derive Category" }],
    ["a hash that isn't one", { fromSchema: "recorded-old-schema-hash" }],
    ["the same hash on both sides", { toSchema: fromSchema }],
    ["an output that isn't an object", { output: v.string() }],
    ["an input that isn't an object", { input: v.array(v.string()) }],
    ["a handler that isn't a function", { handler: "row => row" }],
    ["a key it doesn't have", { connector: "mail" }],
    ["no fixtures", { fixtures: undefined }],
    ["an empty list of fixtures", { fixtures: [] }],
    ["more fixtures than it may have", { fixtures: manyFixtures(17) }],
    ["a fixture that isn't `{ row, expect? }`", { fixtures: [{ title: "x" }] }],
    ["a hole for its only fixture", { fixtures: onlyHole }],
    ["a list of fixtures with a hole", { fixtures: holeyFixtures }],
    ["a fixture's row that isn't an object", { fixtures: [{ row: [1] }] }],
    [
      "a fixture's row that isn't JSON",
      { fixtures: [{ row: { at: new Date(0) } }] },
    ],
    [
      "a fixture's number that isn't finite",
      { fixtures: [{ row: { n: Number.NaN } }] },
    ],
    [
      "a fixture's key that reaches a prototype",
      { fixtures: [{ row: prototypeRow }] },
    ],
    [
      "fixtures past their bytes",
      { fixtures: [{ row: { body: "x".repeat(70 * 1024) } }] },
    ],
  ])("is refused with %s", (_case, change) => {
    expect(() => looseMigration({ ...declaration, ...change })).toThrow(
      expect.objectContaining({ code: "migration.invalid_definition" })
    );
  });

  test("is refused with a getter, which could answer differently each read", () => {
    const shifting = { ...declaration };
    Object.defineProperty(shifting, "table", {
      enumerable: true,
      get: () => "notes",
    });
    expect(() => looseMigration(shifting)).toThrow(/not a getter/u);
  });
});

describe("an App's migrations", () => {
  test("are recorded in its manifest, which reads back declared again", () => {
    const { manifest } = inspectApp(notes([deriveCategory]));
    const read = readAppManifest(JSON.stringify(manifest));

    expect(read.migrations).toStrictEqual(manifest.migrations);
    expect(read.migrations).toMatchObject({
      "derive-note-category": {
        name: "derive-note-category",
        table: "notes",
        fromSchema,
        toSchema,
        input: { kind: "object" },
        output: { kind: "object" },
        fixtures: [
          {
            row: { title: "Plan", body: "Launch day" },
            expect: { title: "Plan", body: "Launch day", category: "launch" },
          },
          { row: { title: "Idea" }, expect: null },
        ],
      },
    });
  });

  test.each([
    [
      "a table the schema doesn't have",
      [looseMigration({ ...declaration, table: "people" })],
      /a table the schema doesn't have/u,
    ],
    [
      "an output that isn't exactly the table's fields",
      [
        looseMigration({
          ...declaration,
          output: v.object({ ...noteFields, category: v.string() }),
        }),
      ],
      /exactly the fields/u,
    ],
    [
      "two of the same name",
      [deriveCategory, looseMigration(declaration)],
      /Two of the App's migrations are named/u,
    ],
    [
      "two of the same table",
      [deriveCategory, looseMigration({ ...declaration, name: "another" })],
      /Two of the App's migrations transform/u,
    ],
    [
      "something `migration` didn't declare",
      [{ "~migration": deriveCategory["~migration"] }],
      /`migration` declarations only/u,
    ],
  ])("are refused with %s", (_case, migrations, message) => {
    expect(() => notes(migrations)).toThrow(message);
  });

  test("can't be forged into a manifest a declaration doesn't make", () => {
    const { manifest } = inspectApp(notes([deriveCategory]));
    const declared = manifest.migrations["derive-note-category"];
    /** The manifest's text with the migration as `change` makes it. */
    const forged = (change: Record<string, unknown>): string =>
      JSON.stringify({
        ...manifest,
        migrations: { "derive-note-category": { ...declared, ...change } },
      });

    expect(() => readAppManifest(forged({ table: "people" }))).toThrow(
      /a table the schema doesn't have/u
    );
    expect(() => readAppManifest(forged({ uses: ["model"] }))).toThrow(
      /isn't a migration as a manifest holds one/u
    );
    expect(() => readAppManifest(forged({ fixtures: [] }))).toThrow(
      /between 1 and 16/u
    );
  });

  test("record every fixture declared, so the manifest reads back as declared", () => {
    const declared = looseMigration({
      ...declaration,
      fixtures: [{ row: { title: "One" } }, { row: { title: "Two" } }],
    });
    const { manifest } = inspectApp(notes([declared]));
    const read = readAppManifest(JSON.stringify(manifest));

    expect(read.migrations["derive-note-category"]?.fixtures).toStrictEqual([
      { row: { title: "One" }, expect: null },
      { row: { title: "Two" }, expect: null },
    ]);
  });
});

// Ways a transform's module code reaches the platform's clock or
// randomness past what the runner takes away (src/determinism.ts): each
// answers what it reached, or reads the clock plainly when it reached
// nothing, which the runner refuses.

/** What calling `method` on `self` answers, if it is a function. */
const called = (method: unknown, self?: unknown): unknown => {
  if (typeof method !== "function") {
    return undefined;
  }
  const answer: unknown = Reflect.apply(method, self, []);
  return answer;
};

/** The value `key` of `holder` has as its own, if it has one. */
const ownValue = (holder: unknown, key: string): unknown =>
  typeof holder === "object" || typeof holder === "function"
    ? Reflect.getOwnPropertyDescriptor(holder ?? {}, key)?.value
    : undefined;

/**
 * Starts generating an extractable key, whose bytes are randomness: the
 * runner refuses the call, before any promise of a key.
 */
const generatedKey = (): unknown =>
  crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"]);

/** Keys as module code could keep them, made before a transform runs. */
const ecdsaKeys = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["sign", "verify"]
);
const rsaPssKeys = await crypto.subtle.generateKey(
  {
    name: "RSA-PSS",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  false,
  ["sign", "verify"]
);
const rsaOaepKeys = await crypto.subtle.generateKey(
  {
    name: "RSA-OAEP",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  false,
  ["encrypt", "decrypt", "wrapKey"]
);
const wrappedKey = await crypto.subtle.importKey(
  "raw",
  new Uint8Array(16),
  "AES-GCM",
  true,
  ["encrypt"]
);
const signed = new Uint8Array([1, 2, 3]);

// The cases below that answer a promise only start it: a handler answers
// its row, so never sees one settle, but the runner refuses the call.

/** Starts reading a multipart form, with a file in it, from a body. */
const multipartFormRead = (): void => {
  void new Response(
    '--b\r\nContent-Disposition: form-data; name="f"; filename="n"\r\n\r\nx\r\n--b--\r\n',
    { headers: { "content-type": "multipart/form-data; boundary=b" } }
  ).formData();
};

/** The time of the file a form makes of a blob it is given by `key`. */
const formFileTime = (key: "append" | "set"): unknown => {
  const form = new FormData();
  form[key]("f", new Blob(["x"]), "n");
  const file = form.get("f");
  return file instanceof File ? file.lastModified : file;
};

/** A timed class, as the global's prototype holds it. */
const globalClass = (name: string): unknown =>
  Reflect.get(Reflect.getPrototypeOf(globalThis) ?? {}, name);

/** A file made by `File` as the global's prototype holds it. */
const fileByGlobalPrototype = (): unknown => {
  const PlatformFile: unknown = globalClass("File");
  return typeof PlatformFile === "function"
    ? Reflect.get(Reflect.construct(PlatformFile, [[], "a"]), "lastModified")
    : undefined;
};

/** A mark made by `PerformanceMark` as the global's prototype holds it. */
const markByGlobalPrototype = (): unknown => {
  const PlatformMark: unknown = globalClass("PerformanceMark");
  return typeof PlatformMark === "function"
    ? Reflect.get(Reflect.construct(PlatformMark, ["a"]), "startTime")
    : undefined;
};

/** `Date.now` read through its descriptor, which a proxy's `get` never sees. */
const nowByDescriptor = (): unknown => called(ownValue(Date, "now"), Date);

/** `Date.now` read through every descriptor of `Date` at once. */
const nowByDescriptors = (): unknown =>
  called(Object.getOwnPropertyDescriptors(Date).now.value, Date);

/** `Date.now` read through the descriptor of a date's constructor. */
const nowByPrototype = (): unknown => {
  const prototype: unknown = Reflect.getPrototypeOf(new Date(0));
  const constructor = ownValue(prototype, "constructor");
  return called(ownValue(constructor, "now"), constructor);
};

/** `performance.now` read on the prototype the platform keeps it on. */
const timelineByPrototype = (): unknown =>
  called(ownValue(Reflect.getPrototypeOf(performance), "now"), performance);

/** A date made by the platform's `Date`, if `reach` hands it to `capture`. */
const handedDate = (
  reach: (capture: (target: unknown) => void) => unknown
): unknown => {
  let handed: unknown;
  reach((target) => {
    handed = target;
  });
  if (typeof handed !== "function") {
    return Date.now();
  }
  const made: unknown = Reflect.construct(handed, []);
  return String(made);
};

/** The proxy traps module code could define on `Object.prototype`. */
const traps = ["getOwnPropertyDescriptor", "has", "ownKeys"] as const;

/**
 * Proxy traps defined on `Object.prototype`: a handler that inherits them
 * calls them with its target.
 */
const nowByInheritedTrap = (): unknown =>
  handedDate((capture) => {
    const objectPrototype: object = Object.prototype;
    for (const trap of traps) {
      Reflect.defineProperty(objectPrototype, trap, {
        configurable: true,
        value: (target: object, ...rest: unknown[]): unknown => {
          capture(target);
          const answer: unknown = Reflect.apply(Reflect[trap], undefined, [
            target,
            ...rest,
          ]);
          return answer;
        },
      });
    }
    try {
      Reflect.getOwnPropertyDescriptor(Date, "length");
      Reflect.has(Date, "length");
      Reflect.ownKeys(Date);
    } finally {
      for (const trap of traps) {
        Reflect.deleteProperty(objectPrototype, trap);
      }
    }
  });

/** `Reflect.construct` replaced while a date is made: what it is handed. */
const nowByConstruct = (): unknown =>
  handedDate((capture) => {
    const real = Reflect.construct;
    Reflect.set(
      Reflect,
      "construct",
      (...args: Parameters<typeof real>): unknown => {
        capture(args[0]);
        const made: unknown = real(...args);
        return made;
      }
    );
    try {
      return new Date(0);
    } finally {
      Reflect.set(Reflect, "construct", real);
    }
  });

/**
 * `Reflect.apply` replaced while a formatter's `format` is read: the
 * platform's getter it is handed answers the platform's `format`, which
 * formats the time when given no date.
 */
const nowByApply = (): unknown => {
  const real = Reflect.apply;
  let reached: unknown;
  Reflect.set(Reflect, "apply", (...args: Parameters<typeof real>): unknown => {
    const answer: unknown = real(...args);
    if (typeof reached !== "function" && typeof answer === "function") {
      reached = answer;
    }
    return answer;
  });
  try {
    Reflect.get(new Intl.DateTimeFormat("en"), "format");
  } finally {
    Reflect.set(Reflect, "apply", real);
  }
  return typeof reached === "function"
    ? called(reached)
    : new Intl.DateTimeFormat("en").format();
};

/** The clock and randomness, read plainly. */
const clockAndRandom = (): string => `${Date.now()}:${Math.random()}`;

/** The platform's clocks and randomness, as module code could keep them. */
const platformNow = Date.now.bind(Date);
const platformTimeline = performance.now.bind(performance);
const platformUUID = crypto.randomUUID.bind(crypto);

/** Replaces `key` of `target` with `value`; what puts it back. */
const replaced = (
  target: object,
  key: string,
  value: unknown
): (() => void) => {
  const before = Reflect.getOwnPropertyDescriptor(target, key);
  Reflect.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (before === undefined) {
      Reflect.deleteProperty(target, key);
    } else {
      Reflect.defineProperty(target, key, before);
    }
  };
};

/** `Object.defineProperty`, except that it skips the clock and randomness. */
const realDefineProperty = Object.defineProperty;
const skipping = (
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor
): object =>
  key === "now" || key === "random"
    ? target
    : realDefineProperty(target, key, descriptor);

describe("the runner", () => {
  const registered = notes([deriveCategory]);

  test("transforms each row with deterministic metadata only", () => {
    expect(
      runMigration(registered, {
        name: "derive-note-category",
        rows: [
          { id: "n1", fields: { title: "Plan", body: "Launch day" } },
          { id: "n2", fields: { title: "Idea", body: "" } },
        ],
      })
    ).toStrictEqual({
      ok: true,
      rows: [
        { title: "Plan", body: "Launch day", category: "launch" },
        { title: "Idea", body: "", category: "general:n2" },
      ],
    });
  });

  test.each([
    ["randomness", "randomness", () => Math.random()],
    ["random values", "randomness", () => crypto.randomUUID()],
    ["a generated key", "randomness", generatedKey],
    ["the clock", "the clock", () => Date.now()],
    ["the current date", "the clock", () => new Date().toISOString()],
    ["the clock's descriptor", "the clock", nowByDescriptor],
    ["the clock's descriptors", "the clock", nowByDescriptors],
    ["the clock past a prototype", "the clock", nowByPrototype],
    ["the timeline past its prototype", "the clock", timelineByPrototype],
    ["the clock to a trap it inherits", "the clock", nowByInheritedTrap],
    ["the clock to a replaced construct", "the clock", nowByConstruct],
    ["the clock to a replaced apply", "the clock", nowByApply],
    ["a file's time", "the clock", () => new File([], "a").lastModified],
    ["a mark's time", "the clock", () => new PerformanceMark("a").startTime],
    ["a marked time", "the clock", () => performance.mark("a").startTime],
    ["a measure", "the clock", () => performance.measure("a").duration],
    ["a file past the global", "the clock", fileByGlobalPrototype],
    ["a mark past the global", "the clock", markByGlobalPrototype],
    ["an appended file's time", "the clock", () => formFileTime("append")],
    ["a set file's time", "the clock", () => formFileTime("set")],
    ["a read form's files", "the clock", multipartFormRead],
    [
      "a form body's boundary",
      "randomness",
      () => new Response(new FormData()).headers.get("content-type"),
    ],
    [
      "a form request's boundary",
      "randomness",
      () =>
        new Request("https://example.test", {
          method: "POST",
          body: new FormData(),
        }).headers.get("content-type"),
    ],
    [
      "an ECDSA signature",
      "randomness",
      () => {
        void crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          ecdsaKeys.privateKey,
          signed
        );
      },
    ],
    [
      "an RSA-PSS signature",
      "randomness",
      () => {
        void crypto.subtle.sign(
          { name: "rsa-pss", saltLength: 32 },
          rsaPssKeys.privateKey,
          signed
        );
      },
    ],
    [
      "RSA-OAEP encryption",
      "randomness",
      () => {
        void crypto.subtle.encrypt("RSA-OAEP", rsaOaepKeys.publicKey, signed);
      },
    ],
    [
      "an RSA-OAEP wrapped key",
      "randomness",
      () => {
        void crypto.subtle.wrapKey("raw", wrappedKey, rsaOaepKeys.publicKey, {
          name: "RSA-OAEP",
        });
      },
    ],
  ])(
    "takes away %s while a handler runs, and gives it back after",
    (_case, refused, impurity) => {
      const impure = looseMigration({
        ...declaration,
        name: "impure",
        handler: (_ctx: unknown, row: object) => ({
          ...row,
          category: String(impurity()),
        }),
      });
      const answer = runMigration(notes([impure]), {
        name: "impure",
        rows: [{ id: "n1", fields: { title: "Plan" } }],
      });
      expect(answer).toMatchObject({ ok: false, index: 0 });
      expect(answer.ok ? "" : answer.message).toContain(refused);
      expect(impurity).not.toThrow();
    }
  );

  test("leaves a handler what draws neither, and gives the platform a request's body as checked", async () => {
    const hmacKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const aesKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(16),
      "AES-GCM",
      false,
      ["encrypt"]
    );
    let bodyReads = 0;
    // A plain body to the check, a form to whatever reads it after.
    const init: RequestInit = {
      method: "POST",
      get body(): BodyInit {
        bodyReads += 1;
        return bodyReads === 1 ? "plain" : new FormData();
      },
    };
    const pure = looseMigration({
      ...declaration,
      name: "pure",
      handler: (_ctx: unknown, row: object) => {
        const form = new FormData();
        form.append("a", "b");
        // Started only: a handler answers its row, not a promise.
        void crypto.subtle.sign("HMAC", hmacKey, signed);
        void crypto.subtle.encrypt(
          { name: "AES-GCM", iv: new Uint8Array(12) },
          aesKey,
          signed
        );
        const request = new Request("https://example.test", init);
        return {
          ...row,
          category: `${String(form.has("a"))}:${request.headers.get("content-type") ?? ""}`,
        };
      },
    });
    expect(
      runMigration(notes([pure]), {
        name: "pure",
        rows: [{ id: "n1", fields: { title: "Plan" } }],
      })
    ).toMatchObject({
      ok: true,
      rows: [{ title: "Plan", category: "true:text/plain;charset=UTF-8" }],
    });
  });

  test.each([
    [
      "Array.prototype.map",
      () => replaced(Array.prototype, "map", () => []),
      clockAndRandom,
      "the clock",
    ],
    [
      "Array.prototype.toReversed",
      () => replaced(Array.prototype, "toReversed", () => []),
      clockAndRandom,
      "the clock",
    ],
    [
      "Object.defineProperty",
      () => replaced(Object, "defineProperty", skipping),
      clockAndRandom,
      "the clock",
    ],
    [
      "a `get` on Object.prototype",
      () => replaced(Object.prototype, "get", () => platformNow),
      clockAndRandom,
      "the clock",
    ],
    [
      "performance's own `now`",
      () => replaced(performance, "now", platformTimeline),
      () => performance.now(),
      "the clock",
    ],
    [
      "crypto's own `randomUUID`",
      () => replaced(crypto, "randomUUID", platformUUID),
      () => crypto.randomUUID(),
      "randomness",
    ],
  ])(
    "takes away what module code reaches and gives it back after, though it replaced %s before",
    (_case, replace, impurity, refused) => {
      const impure = looseMigration({
        ...declaration,
        name: "impure",
        handler: (_ctx: unknown, row: object) => ({
          ...row,
          category: String(impurity()),
        }),
      });
      const app = notes([impure]);
      const undo = replace();
      let answer: ReturnType<typeof runMigration>;
      try {
        answer = runMigration(app, {
          name: "impure",
          rows: [{ id: "n1", fields: { title: "Plan" } }],
        });
      } finally {
        undo();
      }
      expect(answer).toMatchObject({ ok: false, index: 0 });
      expect(answer.ok ? "" : answer.message).toContain(refused);
      expect(impurity).not.toThrow();
    }
  );

  test("names the row whose handler threw, or answered a promise", () => {
    const failing = looseMigration({
      ...declaration,
      name: "failing",
      handler: (ctx: { id: string }, row: unknown) => {
        if (ctx.id === "n2") {
          throw new Error("No category for this one");
        }
        return row;
      },
    });
    const waiting = looseMigration({
      ...declaration,
      name: "waiting",
      handler: async (_ctx: unknown, row: unknown) =>
        await Promise.resolve(row),
    });
    const rows = [
      { id: "n1", fields: { title: "One" } },
      { id: "n2", fields: { title: "Two" } },
    ];
    expect(
      runMigration(notes([failing]), { name: "failing", rows })
    ).toStrictEqual({
      ok: false,
      index: 1,
      message: "No category for this one",
    });
    const waited = runMigration(notes([waiting]), {
      name: "waiting",
      rows,
    });
    expect(waited).toMatchObject({ ok: false, index: 0 });
    expect(waited.ok ? "" : waited.message).toContain("not a promise");
  });

  test("refuses a migration the App doesn't register", () => {
    expect(() =>
      runMigration(registered, { name: "missing", rows: [] })
    ).toThrow(expect.objectContaining({ code: "migration.not_found" }));
  });
});
