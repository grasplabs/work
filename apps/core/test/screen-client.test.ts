import { GraspError } from "@grasp-os/sdk/client";
import { clientInternals, GraspClient } from "@grasp-os/sdk/host";
import type { ClientTransport } from "@grasp-os/sdk/host";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { appIdSchema, storeIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import {
  appFunctionPath,
  querySubscriptionLimits,
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { versionFiles } from "../src/apps.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { withScreenReferences } from "../src/screen-references.ts";
import { buildScreens } from "../src/screens.ts";
import { StoreHost } from "../src/store-host.ts";
import { storeMaxWatches } from "../src/store-watches.ts";
import { pastAccessRecheck } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { apiOf, notesFiles as files, referenceTo } from "./notes-client-app.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { openRpc, outcome, routed, signedInApi } from "./sign-in.ts";

// The session client a screen's queries, mutations and actions go through
// (spec 10.1, 10.7.1), against core's real function route, as an approved
// screen's page relays them: a Notes App created, loaded, edited and
// deleted; a lost response recovered from its receipt, never saved twice;
// a cancelled save that still commits and can't be duplicated; caller
// keys reused for other input or past their receipt refused; an action's
// lost response never repeated; and arguments the operation can't take
// refused before anything is sent.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

/**
 * A builder's Notes App, made current, its screen approved by an admin and
 * opened: the release, the screen's lease, and the builder's session.
 */
const openedApp = async (appFiles: Record<string, string> = files) => {
  const builder = await personApi("builder");
  const admin = await personApi("admin");
  const { id } = await builder.api.apps.create({ name: "Notes" });
  const { version } = await builder.api.apps.files.commit(
    id,
    appFiles,
    "First"
  );
  await builder.api.apps.versions.setCurrent(id, version);
  const review = await admin.api.screenTrust.review(id);
  await admin.api.screenTrust.approve(id, {
    version: review.version,
    generation: review.generation,
    artifacts: builtArtifacts(review.screens),
  });
  const { lease } = await builder.api.screens.open(id, "notes");
  // The frame's connection presents its build, as the page does.
  await builder.api.screens.present(id, lease);
  const release = await loadRelease(env, id, version);
  return {
    app: id,
    lease,
    cookie: builder.session,
    userId: builder.userId,
    release,
    builder,
    screens: builder.api.screens,
  };
};

type Opened = Awaited<ReturnType<typeof openedApp>>;

/** Where a page's live queries go: one connection's `screens`, presented. */
type Screens = Opened["screens"];

/**
 * What the page does with a call the frame sends (apps/web's
 * screen-host.ts): posts it to core's function route under the screen's
 * lease, naming the person it was opened for, answers core's answer, and
 * rejects a refusal with its code; and
 * follows a query over its connection to core (`watchQuery`), the
 * callback's disposal telling the client core let go of it.
 */
const pageTransport = (
  {
    app,
    lease,
    cookie,
    userId,
  }: Pick<Opened, "app" | "lease" | "cookie" | "userId">,
  screens: Screens
): ClientTransport => ({
  watch: async (request, onSnapshot, onLost) => {
    const callback = Object.assign(
      (push: unknown): void => {
        onSnapshot(push);
      },
      { [Symbol.dispose]: onLost }
    );
    const subscription = await screens.watchQuery(
      app,
      lease,
      request,
      callback
    );
    return {
      release: () => {
        void subscription.release().catch(() => {
          // Gone with the connection.
        });
      },
    };
  },
  call: async (request) => {
    const response = await routed(`${appFunctionPath}/${app}`, {
      method: "POST",
      headers: {
        origin: clientOrigin,
        "content-type": "application/json",
        cookie,
        [screenLeaseHeader]: lease,
        [screenPersonHeader]: userId,
      },
      body: request,
    });
    const answer: unknown = await response.json();
    if (response.ok) {
      return answer;
    }
    const payload = errorPayloadSchema.parse(answer);
    // As the page does: of a refusal's details, how long to wait.
    const retryAfterMs = payload.details?.retryAfterMs;
    throw Object.assign(new Error(payload.message), {
      code: payload.code,
      ...(typeof retryAfterMs === "number"
        ? { details: { retryAfterMs } }
        : {}),
    });
  },
});

/** The network between page and core, which can drop answers on the way back. */
const network = (transport: ClientTransport) => {
  let dropping = 0;
  let sent = 0;
  return {
    transport: {
      watch: transport.watch,
      call: async (request: string, app: string) => {
        sent += 1;
        const answer = await transport.call(request, app);
        if (dropping > 0) {
          dropping -= 1;
          // The request reached core; its answer didn't come back.
          throw new Error("The connection was reset.");
        }
        return answer;
      },
    } satisfies ClientTransport,
    /** Drops the next `count` answers. */
    drop: (count: number) => {
      dropping = count;
    },
    /** How many requests reached core so far. */
    sent: () => sent,
  };
};

/** A client over the page's transport, as the frame's runtime mounts it. */
const clientFor = (opened: Opened, screens: Screens = opened.screens) => {
  const net = network(pageTransport(opened, screens));
  return { client: new GraspClient(net.transport), net };
};

/** Why `promise` rejected: the structured error's code, category and details. */
const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof GraspError)) {
      throw error;
    }
    const { code, category, details } = error;
    return { code, category, details };
  }
  throw new Error("It resolved");
};

/** The titles of the notes the App holds, newest first. */
const titles = async (client: GraspClient, api: ReturnType<typeof apiOf>) => {
  const page = await client.query(api.list, { pagination: {} });
  return page.items.map((note) => note.title);
};

describe("the session client", { timeout: 120_000 }, () => {
  it("creates, loads, edits and deletes notes, with direct values", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);

    const id = await client.mutation(api.create, { title: "  Launch  " });
    const created = await client.query(api.get, { id });
    expect(created).toMatchObject({
      _id: id,
      title: "Launch",
      body: "",
      _rev: 1,
    });
    const edited = await client.mutation(api.update, {
      id,
      expectedRevision: 1,
      title: "Launch plan",
      body: "Ship it",
    });
    expect(edited).toMatchObject({
      title: "Launch plan",
      body: "Ship it",
      _rev: 2,
    });
    await expect(titles(client, api)).resolves.toStrictEqual(["Launch plan"]);
    await expect(
      client.mutation(api.remove, { id, expectedRevision: 2 })
    ).resolves.toBeNull();
    // Null is the query's own answer for a note that isn't there.
    await expect(client.query(api.get, { id })).resolves.toBeNull();
  });

  it("rejects a stale revision with data.conflict, and an App's own failure as it threw it", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const id = await client.mutation(api.create, { title: "Draft" });
    await client.mutation(api.update, {
      id,
      expectedRevision: 1,
      title: "Theirs",
      body: "",
    });
    await expect(
      failureOf(
        client.mutation(api.update, {
          id,
          expectedRevision: 1,
          title: "Mine",
          body: "",
        })
      )
    ).resolves.toMatchObject({ code: "data.conflict", category: "domain" });
    await expect(client.query(api.get, { id })).resolves.toMatchObject({
      title: "Theirs",
    });
  });

  it("recovers a mutation whose answer was lost from its receipt, saving it once", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, net } = clientFor(opened);
    net.drop(1);
    const id = await client.mutation(api.create, { title: "Once" });
    // The retry reached core and got the first commit's answer.
    expect(net.sent()).toBe(2);
    await expect(client.query(api.get, { id })).resolves.toMatchObject({
      title: "Once",
    });
    await expect(titles(client, api)).resolves.toStrictEqual(["Once"]);
  });

  it("makes each explicit call a submission of its own, and joins one with the same key and input", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const [first, second] = await Promise.all([
      client.mutation(api.create, { title: "Twin" }),
      client.mutation(api.create, { title: "Twin" }),
    ]);
    expect(first).not.toBe(second);
    const keyed = { idempotencyKey: "save-once" };
    const [one, again] = await Promise.all([
      client.mutation(api.create, { title: "Keyed" }, keyed),
      // Normalized as the host normalizes it: the same input.
      client.mutation(api.create, { title: " Keyed ", body: "" }, keyed),
    ]);
    expect(again).toBe(one);
    await expect(titles(client, api)).resolves.toHaveLength(3);
  });

  it("refuses a caller key reused for other input, and one whose receipt expired", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const keyed = { idempotencyKey: "monday-report" };
    const id = await client.mutation(api.create, { title: "Report" }, keyed);
    await expect(
      client.mutation(api.create, { title: "Report" }, keyed)
    ).resolves.toBe(id);
    await expect(
      failureOf(client.mutation(api.create, { title: "Other" }, keyed))
    ).resolves.toMatchObject({ code: "submission.key_conflict" });

    const store = opened.release.store?.storeId ?? "";
    await runInDurableObject(
      env.DATA_STORES.getByName(store),
      async (_instance, state) => {
        // The store's sweep, as at 31 days from now: past the receipt's
        // retention, within its tombstone's.
        await new StoreHost(state, env).sweepReceipts(
          new Date(Date.now() + 31 * 24 * 3_600_000)
        );
      }
    );
    await expect(
      failureOf(client.mutation(api.create, { title: "Report" }, keyed))
    ).resolves.toMatchObject({ code: "submission.expired" });
    await expect(titles(client, api)).resolves.toStrictEqual(["Report"]);
  });

  it("stops a cancelled caller waiting, while the save commits and can't be sent twice", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, net } = clientFor(opened);
    const keyed = { idempotencyKey: "cancelled-save" };
    const controller = new AbortController();
    // The answer is lost, so the save is still reconciling when it aborts.
    net.drop(1);
    const waiting = client.mutation(
      api.create,
      { title: "Kept" },
      { ...keyed, signal: controller.signal }
    );
    controller.abort();
    await expect(failureOf(waiting)).resolves.toMatchObject({
      code: "submission.cancelled",
      details: { sent: true },
    });
    // The same key and input joins the submission still in flight.
    const id = await client.mutation(api.create, { title: "Kept" }, keyed);
    await expect(titles(client, api)).resolves.toStrictEqual(["Kept"]);
    await expect(client.query(api.get, { id })).resolves.toMatchObject({
      title: "Kept",
    });
    // Aborted before it was sent, nothing is.
    const before = net.sent();
    await expect(
      failureOf(
        client.mutation(
          api.create,
          { title: "Never" },
          { signal: AbortSignal.abort() }
        )
      )
    ).resolves.toMatchObject({
      code: "submission.cancelled",
      details: { sent: false },
    });
    expect(net.sent()).toBe(before);
  });

  it("releases only the reader that aborts a query", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    await client.mutation(api.create, { title: "Shared" });
    const controller = new AbortController();
    const args = { pagination: { pageSize: 10 } };
    const aborted = client.query(api.list, args, { signal: controller.signal });
    const kept = client.query(api.list, args);
    controller.abort();
    await expect(failureOf(aborted)).resolves.toMatchObject({
      code: "query.cancelled",
    });
    await expect(kept).resolves.toMatchObject({
      items: [{ title: "Shared" }],
      hasMore: false,
    });
  });

  it("never sends an action again when its answer is lost, and recovers it by its key", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, net } = clientFor(opened);
    // The empty input may be left out: its default applies.
    await expect(client.action(api.echo)).resolves.toBe("hello");
    net.drop(1);
    const before = net.sent();
    const lost = await failureOf(client.action(api.echo, { word: "once" }));
    expect(lost).toMatchObject({
      code: "submission.outcome_unknown",
      category: "uncertain",
    });
    expect(net.sent()).toBe(before + 1);
    const { idempotencyKey } = z
      .object({ idempotencyKey: z.string() })
      .parse(lost.details);
    await expect(
      client.action(api.echo, { word: "once" }, { idempotencyKey })
    ).resolves.toBe("once");
  });

  it("saves from two tabs that read more at once than the person's request budget holds", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const tabs = [clientFor(opened).client, clientFor(opened).client];
    // Each tab reads a dozen queries at once and saves meanwhile: more
    // than the budget's burst between them, so some are refused, and the
    // saves wait for it to give requests back rather than fail.
    const saved = await Promise.all(
      tabs.map(async (client, tab) => {
        const reads = Array.from(
          { length: 12 },
          async (_, index) =>
            await client.query(api.list, {
              pagination: { pageSize: index + 1 },
            })
        );
        const id = await client.mutation(api.create, {
          title: `From tab ${tab + 1}`,
        });
        await Promise.all(reads);
        return id;
      })
    );
    expect(new Set(saved).size).toBe(2);
    const { client } = clientFor(opened);
    await expect(titles(client, api)).resolves.toStrictEqual(
      expect.arrayContaining(["From tab 1", "From tab 2"])
    );
  });

  it("refuses arguments and options the call can't take before sending anything", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, net } = clientFor(opened);
    await expect(
      failureOf(client.mutation(api.create, { title: "   " }))
    ).resolves.toMatchObject({
      code: "contract.invalid_args",
      category: "contract",
      details: { issues: [{ path: ["title"] }] },
    });
    await expect(
      failureOf(
        client.mutation(api.create, { title: "Fine" }, { idempotencyKey: "" })
      )
    ).resolves.toMatchObject({ code: "submission.key_invalid" });
    const id = await client.mutation(api.create, { title: "Real" });
    const sent = net.sent();
    // A query takes no key: the type refuses it, and so does the client.
    await expect(
      // @ts-expect-error -- a query takes no idempotency key
      client.query(api.get, { id }, { idempotencyKey: "no" })
    ).rejects.toThrow(TypeError);
    // A reference that isn't a public query.
    await expect(
      // @ts-expect-error -- a mutation isn't a query, and the client checks
      failureOf(client.query(api.create, { id }))
    ).resolves.toMatchObject({ code: "contract.invalid_request" });
    expect(net.sent()).toBe(sent);
  });
});

/** A screen of the Notes App whose component runs `body` first. */
const screen = (body: string): string =>
  `import { useMutation, useQuery } from "@grasp-os/sdk/react";
import { api } from "#grasp";

export default function Notes() {
${body}
  return null;
}
`;

/** How many inspected manifests core keeps. */
const inspections = async (): Promise<number> => {
  const { objects } = await env.FILES.list({ prefix: "inspections/" });
  return objects.length;
};

describe("a screen's build", { timeout: 120_000 }, () => {
  it("builds a saved or drafted version's screens with the references its own code generates", async () => {
    // A save and a draft's check build alike (save-builds.ts): nothing of
    // either is sealed yet, so the references come from the files.
    const builder = await personApi("builder");
    const { id } = await builder.api.apps.create({ name: "Notes" });
    const { builds } = await builder.api.apps.files.commit(id, files, "First");
    expect(builds.screens).toMatchObject({ status: "ok", diagnostics: [] });
    const broken = await builder.api.apps.files.commit(
      id,
      {
        ...files,
        "screens/notes.tsx": screen(
          '  useQuery(api.notes.get, { noteId: "x" });'
        ),
      },
      "Second"
    );
    expect(broken.builds.screens.status).toBe("failed");
  });

  it("inspects the same server code once, however often a save brings it", async () => {
    const builder = await personApi("builder");
    // Server code of its own, so no other test inspected it already.
    const operations = `${files["operations/notes.ts"] ?? ""}\n// ${crypto.randomUUID()}\n`;
    const own = { ...files, "operations/notes.ts": operations };
    const before = await inspections();
    const { id } = await builder.api.apps.create({ name: "Notes" });
    await builder.api.apps.files.commit(id, own, "First");
    // A screen changed, the server code not: what was inspected is kept.
    await builder.api.apps.files.commit(
      id,
      { ...own, "screens/notes.tsx": screen("") },
      "Second"
    );
    await expect(inspections()).resolves.toBe(before + 1);
    // Other server code is inspected for itself.
    await builder.api.apps.files.commit(
      id,
      {
        ...own,
        "operations/notes.ts": operations.replace(
          '.default("hello")',
          '.default("hi")'
        ),
      },
      "Third"
    );
    await expect(inspections()).resolves.toBe(before + 2);
  });

  /** The diagnostics of version 1 of an App holding `files`, as core builds its screens. */
  const diagnosticsOf = async (
    appFiles: Record<string, string>
  ): Promise<string[]> => {
    const builder = await personApi("builder");
    const { id } = await builder.api.apps.create({ name: "Notes" });
    const { version } = await builder.api.apps.files.commit(
      id,
      appFiles,
      "First"
    );
    const build = await buildScreens(
      env,
      await withScreenReferences(
        env,
        appIdSchema.parse(id),
        version,
        await versionFiles(env, appIdSchema.parse(id), version)
      )
    );
    return build.diagnostics
      .filter(({ severity }) => severity === "error")
      .map(({ message }) => message);
  };

  it("loads the App's references and the React SDK into the screen", async () => {
    const opened = await openedApp();
    const build = await buildScreens(
      env,
      await withScreenReferences(
        env,
        appIdSchema.parse(opened.app),
        opened.release.manifest.resourceVersion,
        await versionFiles(
          env,
          appIdSchema.parse(opened.app),
          opened.release.manifest.resourceVersion
        )
      )
    );
    if (!build.ok) {
      throw new Error("The screen didn't build");
    }
    const closure = build.screens["app~screens~notes.js"];
    expect(closure?.modules).toStrictEqual([
      "app~.grasp~references.js",
      "app~screens~notes.js",
    ]);
    expect(closure?.kitModules).toContain("@grasp-os~sdk~react.js");
  });

  it("fails the type check on arguments a reference doesn't take, without a cast", async () => {
    await expect(
      diagnosticsOf({
        ...files,
        "screens/notes.tsx": screen(`  useQuery(api.notes.get, { noteId: "x" });
  const create = useMutation(api.notes.create);
  void create();`),
      })
    ).resolves.toStrictEqual([
      expect.stringContaining("noteId"),
      expect.stringContaining("Expected 1-2 arguments, but got 0"),
    ]);
  });

  it("refuses a screen that makes its own client", async () => {
    await expect(
      diagnosticsOf({
        ...files,
        "screens/notes.tsx": `import { GraspClient } from "@grasp-os/sdk/client";
export default function Notes() {
  return <p>{String(GraspClient)}</p>;
}
`,
      })
    ).resolves.toStrictEqual([
      expect.stringContaining("the platform's: it makes the session client"),
    ]);
  });

  it("tells an App without server code that it has no references yet", async () => {
    await expect(
      diagnosticsOf({
        "screens/notes.tsx": screen("  void api;"),
      })
    ).resolves.toStrictEqual([
      expect.stringContaining("which this App doesn't have yet"),
    ]);
  });

  it("builds forms of the operations, the record and a native schema, typed by what they bind", async () => {
    const formScreen = `import { v } from "@grasp-os/sdk";
import type { ReturnOf } from "@grasp-os/sdk";
import { useForm } from "@grasp-os/sdk/react";
import { Form, FormError, SubmitButton, TextareaField, TextField } from "@grasp-os/ui/form";
import { api } from "#grasp";

type Note = NonNullable<ReturnOf<typeof api.notes.get>>;

const searchSchema = v.object({ search: v.string().trim().min(1) });

export function Editor({ note }: { note: Note }) {
  const create = useForm(api.notes.create, { defaultValues: { title: "", body: "" }, resetOnSuccess: true });
  const edit = useForm(api.notes.update, {
    record: note,
    fields: ["title", "body"],
    args: (baseline) => ({ id: baseline._id, expectedRevision: baseline._rev }),
  });
  const search = useForm(searchSchema, { defaultValues: { search: "" }, onSubmit: (values) => values.search });
  return (
    <>
      <Form form={create}>
        <TextField form={create} label="Title" name="title" />
        <TextareaField form={create} label="Body" name="body" />
        <FormError form={create} />
        <SubmitButton form={create}>Create note</SubmitButton>
      </Form>
      <Form form={edit}>
        <TextField form={edit} label="Title" name="title" />
        <SubmitButton form={edit}>Save changes</SubmitButton>
      </Form>
      <Form form={search}>
        <TextField form={search} label="Search" name="search" />
        <SubmitButton form={search}>Apply filter</SubmitButton>
      </Form>
    </>
  );
}

export default function Notes() {
  return null;
}
`;
    await expect(
      diagnosticsOf({ ...files, "screens/notes.tsx": formScreen })
    ).resolves.toStrictEqual([]);
    await expect(
      diagnosticsOf({
        ...files,
        "screens/notes.tsx": formScreen.replace(
          '<TextField form={create} label="Title" name="title" />',
          '<TextField form={create} label="Owner" name="owner" />'
        ),
      })
    ).resolves.toStrictEqual([expect.stringContaining('"owner"')]);
  });

  it("gives screens only the native values of the SDK's root", async () => {
    await expect(
      diagnosticsOf({
        ...files,
        "screens/notes.tsx": `import { app } from "@grasp-os/sdk";
export default function Notes() {
  return <p>{typeof app}</p>;
}
`,
      })
    ).resolves.toStrictEqual([
      expect.stringContaining("Screens import only { v } from @grasp-os/sdk"),
    ]);
  });
});

// Live queries (spec 11): what a screen's `useQuery` does through the same
// client, over core's real connection, function route and store. A query
// is followed once however many components read it; a change saved
// elsewhere reaches it without the screen asking; pushes stay in order,
// never cross people, stop with access, survive a store restart, and
// pile up no further than one replacement each.

/**
 * What a component reading a query sees, as `useQuery` subscribes:
 * the shared entry's snapshot, as it is now.
 */
const reading = (client: GraspClient, reference: unknown, args: unknown) => {
  const internals = clientInternals(client);
  const entry = internals.entry(reference, args);
  const stop = internals.subscribe(entry, () => {
    // `useSyncExternalStore` reads the snapshot again; the test reads it
    // when it looks.
  });
  return { stop, now: () => entry.snapshot };
};

/** How long a push may take to arrive, and how often to look. */
const pushWait = { timeout: 20_000, interval: 50 };

/** Once `look` passes. */
const eventually = async (look: () => void): Promise<void> => {
  await vi.waitFor(look, pushWait);
};

/** The titles a list snapshot shows, or what it failed with. */
const shown = (snapshot: { value: unknown; error: GraspError | undefined }) => {
  if (snapshot.error !== undefined) {
    return snapshot.error.code;
  }
  const page = z
    .object({ items: z.array(z.object({ title: z.string() })) })
    .safeParse(snapshot.value);
  return page.success ? page.data.items.map(({ title }) => title) : undefined;
};

/**
 * A transport that counts what it follows and holds the answers of
 * calls while `held` is set, to deliver them late.
 */
const countingTransport = (transport: ClientTransport) => {
  let follows = 0;
  let gate: Promise<unknown> | undefined;
  return {
    transport: {
      call: async (request: string) => {
        const answer = await transport.call(request);
        await gate;
        return answer;
      },
      watch: async (...args: Parameters<ClientTransport["watch"]>) => {
        follows += 1;
        return await transport.watch(...args);
      },
    } satisfies ClientTransport,
    follows: () => follows,
    /** Holds every answer until the function it answers is called. */
    hold: () => {
      const { promise, resolve } = Promise.withResolvers<null>();
      gate = promise;
      return () => {
        gate = undefined;
        resolve(null);
      };
    },
  };
};

/** A query's call as the client sends it, for a raw subscription. */
const requestOf = (
  reference: OperationReference<unknown, unknown, ReferenceKind>,
  input: unknown
): string =>
  JSON.stringify({
    reference: {
      resourceId: reference.resourceId,
      resourceVersion: reference.resourceVersion,
      contractId: reference.contractId,
      fingerprint: reference.fingerprint,
      kind: reference.kind,
    },
    input,
  });

/**
 * Runs `run` as if `minutes` had passed: following counts as a request,
 * and a person asks an App's screens twenty things at once at most.
 */
const later = async <T>(minutes: number, run: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + minutes * 60_000 });
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
};

/** The App's store's object. */
const storeObjectOf = (opened: Opened) => {
  const storeId = opened.release.store?.storeId;
  if (storeId === undefined) {
    throw new Error("The Notes App has a store");
  }
  return inJurisdiction(env, env.DATA_STORES).getByName(storeId);
};

describe("live queries", { timeout: 120_000 }, () => {
  it("follows a query once for every reader, and shows a change saved in another tab without asking", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const counted = countingTransport(pageTransport(opened, opened.screens));
    const client = new GraspClient(counted.transport);
    const args = { pagination: { pageSize: 10 } };
    const first = reading(client, api.list, args);
    const second = reading(client, api.list, args);
    await eventually(() => {
      expect(shown(first.now())).toStrictEqual([]);
    });
    // A component that renders again lets go and subscribes in one go,
    // as React does: the subscription stays.
    first.stop();
    const again = reading(client, api.list, args);

    // Another tab of the same session: its own connection to core.
    const { core } = await openRpc(opened.cookie);
    const otherScreens = core.authenticate().screens;
    await otherScreens.present(opened.app, opened.lease);
    const other = clientFor(opened, otherScreens).client;
    await other.mutation(api.create, { title: "From the other tab" });

    await eventually(() => {
      expect(shown(second.now())).toStrictEqual(["From the other tab"]);
    });
    expect({
      again: shown(again.now()),
      follows: counted.follows(),
    }).toStrictEqual({
      again: ["From the other tab"],
      follows: 1,
    });
  });

  it("never shows one person's records to another, and pushes each their own", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "user",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    await member.api.screens.present(opened.app, lease);
    const owner = clientFor(opened).client;
    const theirs = clientFor(
      { ...opened, lease, cookie: member.session, userId: member.userId },
      member.api.screens
    ).client;
    const args = { pagination: { pageSize: 10 } };
    const ownerList = reading(owner, api.list, args);
    const memberList = reading(theirs, api.list, args);
    await eventually(() => {
      expect(shown(memberList.now())).toStrictEqual([]);
    });

    await owner.mutation(api.create, { title: "The owner's" });
    await theirs.mutation(api.create, { title: "The member's" });

    await eventually(() => {
      expect({
        owner: shown(ownerList.now()),
        member: shown(memberList.now()),
      }).toStrictEqual({ owner: ["The owner's"], member: ["The member's"] });
    });
  });

  it("never lets a late answer of a read replace a newer push", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const counted = countingTransport(pageTransport(opened, opened.screens));
    const client = new GraspClient(counted.transport);
    const id = await client.mutation(api.create, { title: "First" });
    const note = reading(client, api.get, { id });
    await eventually(() => {
      expect(note.now().value).toMatchObject({ _rev: 1 });
    });

    // A read whose answer is held back while the note moves on.
    const open = counted.hold();
    const late = client.query(api.get, { id });
    const other = clientFor(opened).client;
    await other.mutation(api.update, {
      id,
      expectedRevision: 1,
      title: "Second",
      body: "",
    });
    await eventually(() => {
      expect(note.now().value).toMatchObject({ _rev: 2, title: "Second" });
    });
    open();
    await late;

    expect(note.now().value).toMatchObject({ _rev: 2, title: "Second" });
  });

  it("clears what a screen shows once the person loses access, before anything more reaches it", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "user",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    await member.api.screens.present(opened.app, lease);
    const theirs = clientFor(
      { ...opened, lease, cookie: member.session, userId: member.userId },
      member.api.screens
    ).client;
    await theirs.mutation(api.create, { title: "Mine" });
    const list = reading(theirs, api.list, { pagination: {} });
    await eventually(() => {
      expect(shown(list.now())).toStrictEqual(["Mine"]);
    });

    await opened.builder.api.apps.members.remove(opened.app, them);
    const owner = clientFor(opened).client;
    // Any commit to what the query read has it read again, as them.
    await pastAccessRecheck(async () => {
      await vi.waitFor(
        async () => {
          await owner.mutation(api.create, { title: "Elsewhere" });
          expect(list.now().error).toBeDefined();
        },
        { timeout: 10_000, interval: 250 }
      );
    });

    expect({
      value: list.now().value,
      code: list.now().error?.code,
    }).toStrictEqual({ value: undefined, code: "app.not_found" });
  });

  it("follows again after the store restarts, and shows a change saved just before", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const list = reading(client, api.list, { pagination: {} });
    await eventually(() => {
      expect(shown(list.now())).toStrictEqual([]);
    });

    const other = clientFor(opened).client;
    await other.mutation(api.create, { title: "Before the restart" });
    // Restarted, as a deploy restarts it, right after the commit: what
    // it held of the screen's watch is gone with it.
    await runInDurableObject(storeObjectOf(opened), (_store, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    await eventually(() => {
      expect(shown(list.now())).toStrictEqual(["Before the restart"]);
    });
    await other.mutation(api.create, { title: "After the restart" });

    await eventually(() => {
      expect(shown(list.now())).toStrictEqual([
        "After the restart",
        "Before the restart",
      ]);
    });
  });

  it("keeps one replacement for a page that doesn't take its pushes, and sends the latest once it does", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const received: { revision: number; titles: string[] }[] = [];
    const taken = Promise.withResolvers<null>();
    let first = true;
    const pushed = z.object({
      revision: z.number(),
      result: z.object({
        ok: z.literal(true),
        value: z.object({ items: z.array(z.object({ title: z.string() })) }),
      }),
    });
    // The page takes the first push only once the test lets it.
    const callback = async (push: unknown): Promise<void> => {
      const { revision, result } = pushed.parse(push);
      received.push({
        revision,
        titles: result.value.items.map(({ title }) => title),
      });
      if (first) {
        first = false;
        await taken.promise;
      }
    };
    await opened.screens.watchQuery(
      opened.app,
      opened.lease,
      requestOf(api.list, { pagination: { pageSize: 50 } }),
      // Core waits for what a page's callback answers: that is the point.
      // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- see above
      callback
    );
    await eventually(() => {
      expect(received).toHaveLength(1);
    });

    const { client } = clientFor(opened);
    const saves = 8;
    for (let note = 1; note <= saves; note += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one save after the other
      await client.mutation(api.create, { title: `Note ${note}` });
    }
    // Room for the reads those saves cause, while the page holds the first.
    await scheduler.wait(1000);
    taken.resolve(null);
    await eventually(() => {
      expect(received.at(-1)?.titles).toHaveLength(saves);
    });

    const revisions = received.map(({ revision }) => revision);
    expect({
      inOrder: revisions.every(
        (revision, at) => at === 0 || revision > (revisions[at - 1] ?? 0)
      ),
      fewerThanSaves: received.length < 1 + saves,
    }).toStrictEqual({ inOrder: true, fewerThanSaves: true });
  });

  it("holds a page to its live queries at once", async () => {
    const opened = await openedApp();
    const follow = async (n: number) =>
      await outcome(
        opened.screens.watchQuery(
          opened.app,
          opened.lease,
          JSON.stringify({ n }),
          () => {
            // Each is refused as a call it can't read, and stays followed.
          }
        )
      );
    const answers: string[] = [];
    // Following counts as a request: twenty a moment, as a screen would.
    for (let minute = 0; minute < 6; minute += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one minute after the other
      const batch = await later(
        minute + 1,
        async () =>
          await Promise.all(
            Array.from(
              { length: 17 },
              async (_, at) => await follow(minute * 17 + at)
            )
          )
      );
      answers.push(...batch);
    }

    expect({
      followed: answers.filter((answer) => answer === "ok").length,
      refused: [...new Set(answers.filter((answer) => answer !== "ok"))],
    }).toStrictEqual({ followed: 100, refused: ["screen.too_many_queries"] });
  });
});

/** A push of core's, as a raw subscription gets it. */
const pushSchema = z.object({
  revision: z.number(),
  result: z.union([
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
  ]),
});
type Push = z.infer<typeof pushSchema>;

/**
 * A page's callback for a raw subscription: what reached it, and whether
 * core let go of it.
 */
const pageFollower = () => {
  const received: Push[] = [];
  const state = { released: false };
  const callback = Object.assign(
    (push: unknown): void => {
      received.push(pushSchema.parse(push));
    },
    {
      [Symbol.dispose]: (): void => {
        state.released = true;
      },
    }
  );
  return { received, state, callback };
};

/** The titles a push shows, or the code it was refused with. */
const titlesOf = (push: Push | undefined): string[] | string | null => {
  if (push === undefined) {
    return null;
  }
  if (!push.result.ok) {
    return push.result.error.code;
  }
  return z
    .object({ items: z.array(z.object({ title: z.string() })) })
    .parse(push.result.value)
    .items.map(({ title }) => title);
};

/**
 * Retitles every note and moves the table on in the store's own
 * database, as a write nobody told the store's watches of would: what a
 * live query only finds by looking again.
 */
const silentlyRetitle = async (opened: Opened, title: string) => {
  await runInDurableObject(storeObjectOf(opened), (_store, state) => {
    state.storage.sql.exec(
      "UPDATE sdk_records SET value_json = json_set(value_json, '$.title', ?), revision = revision + 1",
      title
    );
    state.storage.sql.exec("UPDATE sdk_tables SET generation = generation + 1");
  });
};

/** A member of `opened`'s App, with their own screen's lease and client. */
const memberOf = async (opened: Opened) => {
  const member = await personApi("builder");
  const them = { type: "person", id: member.userId } as const;
  await opened.builder.api.apps.members.add(opened.app, {
    ...them,
    role: "user",
  });
  const { lease } = await member.api.screens.open(opened.app, "notes");
  await member.api.screens.present(opened.app, lease);
  const { client } = clientFor(
    { ...opened, lease, cookie: member.session, userId: member.userId },
    member.api.screens
  );
  return { member, them, lease, client };
};

describe("live queries under load and loss", { timeout: 180_000 }, () => {
  it("charges the reads a burst of commits causes to the person's budget, however many queries they follow", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const writer = await memberOf(opened);
    // A second tab of the owner's: each follows up to its bound.
    const { core } = await openRpc(opened.cookie);
    const otherTab = core.authenticate().screens;
    await otherTab.present(opened.app, opened.lease);
    const followers = Array.from({ length: 150 }, () => pageFollower());
    for (let batch = 0; batch < followers.length / 15; batch += 1) {
      // Following counts as a request: fifteen a moment.
      // oxlint-disable-next-line no-await-in-loop -- one moment after the other
      await later(batch + 1, async () => {
        await Promise.all(
          followers
            .slice(batch * 15, batch * 15 + 15)
            .map(async (follower, at) => {
              const index = batch * 15 + at;
              const screens = index < 100 ? opened.screens : otherTab;
              await screens.watchQuery(
                opened.app,
                opened.lease,
                requestOf(api.list, { pagination: { pageSize: index + 1 } }),
                follower.callback
              );
            })
        );
      });
    }
    await eventually(() => {
      expect(
        followers.every(({ received }) => received.length > 0)
      ).toBeTruthy();
    });
    const before = followers.reduce(
      (sum, { received }) => sum + received.length,
      0
    );

    // Another person's commits to the table every one of them read.
    const started = Date.now();
    for (let note = 1; note <= 12; note += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one commit after the other
      await writer.client.mutation(api.create, { title: `Note ${note}` });
      // oxlint-disable-next-line no-await-in-loop -- spread over a few seconds
      await scheduler.wait(400);
    }
    await scheduler.wait(2000);
    const seconds = (Date.now() - started) / 1000;
    const reads =
      followers.reduce((sum, { received }) => sum + received.length, 0) -
      before;

    const { liveReads, concurrentReads } = querySubscriptionLimits;
    const bound =
      liveReads.burst + (liveReads.perMinute / 60) * seconds + concurrentReads;
    expect({ withinBudget: reads <= bound, read: reads > 0 }).toStrictEqual({
      withinBudget: true,
      read: true,
    });
  });

  it("follows again later when the store holds all the watches it may, instead of giving up", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const store = storeObjectOf(opened);
    const storeId = storeIdSchema.parse(opened.release.store?.storeId);
    const others = Math.ceil(
      storeMaxWatches / querySubscriptionLimits.perPerson
    );
    const held: string[] = [];
    for (let person = 0; person < others; person += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one person's at a time
      const ids = await Promise.all(
        Array.from(
          { length: querySubscriptionLimits.perPerson },
          async () =>
            await store.watch(storeId, `other-${person}`, {}, () => {
              // Another screen, still there.
            })
        )
      );
      held.push(...ids.map(({ id }) => id));
    }
    const { client } = clientFor(opened);
    const list = reading(client, api.list, { pagination: {} });
    await scheduler.wait(3000);
    expect(list.now()).toStrictEqual({ value: undefined, error: undefined });

    // Some of the others stop following: this screen gets its turn.
    await Promise.all(
      held.slice(0, 10).map(async (id) => {
        await store.unwatch(id);
      })
    );

    await vi.waitFor(
      () => {
        expect(shown(list.now())).toStrictEqual([]);
      },
      { timeout: 60_000, interval: 100 }
    );
  });

  it("gives a later reader a fresh read, not a result kept from before a write", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    await clientFor(opened).client.mutation(api.create, { title: "Original" });
    const request = requestOf(api.list, { pagination: {} });
    const first = pageFollower();
    await opened.screens.watchQuery(
      opened.app,
      opened.lease,
      request,
      first.callback
    );
    await eventually(() => {
      expect(titlesOf(first.received.at(-1))).toStrictEqual(["Original"]);
    });

    await silentlyRetitle(opened, "Changed since");
    const joiner = pageFollower();
    await opened.screens.watchQuery(
      opened.app,
      opened.lease,
      request,
      joiner.callback
    );

    await eventually(() => {
      expect(titlesOf(joiner.received[0])).toStrictEqual(["Changed since"]);
    });
  });

  it("finds a write the store never told of by checking its watch now and then", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    await clientFor(opened).client.mutation(api.create, { title: "Original" });
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    try {
      const follower = pageFollower();
      await opened.screens.watchQuery(
        opened.app,
        opened.lease,
        requestOf(api.list, { pagination: {} }),
        follower.callback
      );
      await eventually(() => {
        expect(titlesOf(follower.received.at(-1))).toStrictEqual(["Original"]);
      });

      await silentlyRetitle(opened, "Found later");
      await vi.advanceTimersByTimeAsync(querySubscriptionLimits.livenessMs);

      await eventually(() => {
        expect(titlesOf(follower.received.at(-1))).toStrictEqual([
          "Found later",
        ]);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing a page was owed once a refusal ended its subscription", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { them, lease, member } = await memberOf(opened);
    const received: Push[] = [];
    const stalled = {
      first: Promise.withResolvers<null>(),
      refusal: Promise.withResolvers<null>(),
    };
    // The page doesn't take its first push, nor the refusal, until the
    // test lets it: what core held for it meanwhile must not go out after.
    // Core waits for what a page's callback answers: that is the point.
    // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- see above
    const callback: (push: unknown) => void = async (push) => {
      const read = pushSchema.parse(push);
      received.push(read);
      if (read.revision === 1) {
        await stalled.first.promise;
      } else if (!read.result.ok) {
        await stalled.refusal.promise;
      }
    };
    await member.api.screens.watchQuery(
      opened.app,
      lease,
      requestOf(api.list, { pagination: {} }),
      callback
    );
    await eventually(() => {
      expect(received).toHaveLength(1);
    });
    const owner = clientFor(opened).client;
    // A read the page owes, waiting behind the first.
    await owner.mutation(api.create, { title: "Elsewhere" });
    await scheduler.wait(1500);

    await opened.builder.api.apps.members.remove(opened.app, them);
    await pastAccessRecheck(async () => {
      await vi.waitFor(
        async () => {
          await owner.mutation(api.create, { title: "Again" });
          expect(received.some(({ result }) => !result.ok)).toBeTruthy();
        },
        { timeout: 10_000, interval: 250 }
      );
    });
    stalled.first.resolve(null);
    await scheduler.wait(1500);
    stalled.refusal.resolve(null);
    await scheduler.wait(500);

    expect(
      received.map(({ revision, result }) => ({ revision, ok: result.ok }))
    ).toStrictEqual([
      { revision: 1, ok: true },
      { revision: received[1]?.revision, ok: false },
    ]);
  });

  it("checks a subscription against the following frame's own lease", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    // The connection presented an approved build's lease; this frame's is
    // one core never signed.
    await expect(
      outcome(
        opened.screens.watchQuery(
          opened.app,
          "not-a-lease-core-signed",
          requestOf(api.list, { pagination: {} }),
          pageFollower().callback
        )
      )
    ).resolves.toBe("screen.unreviewed");
  });

  it("backs off following a query that core lets go of after every push", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const page = pageTransport(opened, opened.screens);
    let follows = 0;
    // Core lets go of each subscription right after its first push.
    const client = new GraspClient({
      call: page.call,
      watch: async (request, onSnapshot, onLost) => {
        follows += 1;
        const handle = await page.watch(
          request,
          (push) => {
            onSnapshot(push);
            onLost();
          },
          () => {
            // Told already.
          }
        );
        return handle;
      },
    });
    const list = reading(client, api.list, { pagination: {} });
    await scheduler.wait(6000);
    list.stop();

    expect(follows).toBeLessThanOrEqual(5);
  });
});

describe("live queries: what goes out, and when", { timeout: 180_000 }, () => {
  it("checks access again before a result that waited goes out, with no write to set it off", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { them, lease, member } = await memberOf(opened);
    const received: Push[] = [];
    const first = Promise.withResolvers<null>();
    // The page holds its first push back while a newer result waits.
    // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- core waits for what a page's callback answers
    const callback: (push: unknown) => void = async (push) => {
      const read = pushSchema.parse(push);
      received.push(read);
      if (read.revision === 1) {
        await first.promise;
      }
    };
    await member.api.screens.watchQuery(
      opened.app,
      lease,
      requestOf(api.list, { pagination: {} }),
      callback
    );
    await eventually(() => {
      expect(received).toHaveLength(1);
    });
    await clientFor(opened).client.mutation(api.create, { title: "Theirs" });
    // Room for the read that commit causes: its result waits behind the first.
    await scheduler.wait(1500);

    await opened.builder.api.apps.members.remove(opened.app, them);
    await pastAccessRecheck(async () => {
      first.resolve(null);
      await eventually(() => {
        expect(received.length).toBeGreaterThan(1);
      });
    });

    expect(received.slice(1).map(({ result }) => result.ok)).toStrictEqual([
      false,
    ]);
  });

  it("reads again when the store told of a write before its watch was in place", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const store = storeObjectOf(opened);
    const storeId = storeIdSchema.parse(opened.release.store?.storeId);
    // The owner's screens gone without a word, at the person's bound: the
    // next watch waits while the store asks them whether they're there.
    const asked = Promise.withResolvers<null>();
    await Promise.all(
      Array.from(
        { length: querySubscriptionLimits.perPerson },
        async () =>
          await store.watch(
            storeId,
            opened.builder.userId,
            {},
            // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- a dead screen never answers
            async (tables: string[]) => {
              if (tables.length === 0) {
                asked.resolve(null);
              }
              await Promise.withResolvers<never>().promise;
            }
          )
      )
    );
    const list = reading(clientFor(opened).client, api.list, {
      pagination: {},
    });
    // The query is read, and its watch waits on the sweep: a write now
    // is one the store tells the watch of the moment it is in place,
    // before core heard its ID.
    await asked.promise;
    await clientFor(opened).client.mutation(api.create, {
      title: "Landed meanwhile",
    });
    // With no alarm set, the store sets one before it answers the watch,
    // so its word of the write reaches core first.
    await runInDurableObject(store, async (_store, state) => {
      await state.storage.deleteAlarm();
    });

    await vi.waitFor(
      () => {
        expect(shown(list.now())).toStrictEqual(["Landed meanwhile"]);
      },
      { timeout: 15_000, interval: 100 }
    );
  });

  it("keeps reading other queries while pages hold refusals back", async () => {
    const opened = await openedApp();
    const other = await openedApp();
    const api = apiOf(opened.release);
    const otherApi = apiOf(other.release);
    const { them, lease, member } = await memberOf(opened);
    await other.builder.api.apps.members.add(other.app, {
      ...them,
      role: "user",
    });
    const { lease: otherLease } = await member.api.screens.open(
      other.app,
      "notes"
    );
    const refusals: Push[] = [];
    // A page that never takes the last result of what it follows.
    // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- core waits for what a page's callback answers
    const holding: (push: unknown) => void = async (push) => {
      const read = pushSchema.parse(push);
      if (!read.result.ok) {
        refusals.push(read);
        await Promise.withResolvers<never>().promise;
      }
    };
    for (let size = 1; size <= 4; size += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await member.api.screens.watchQuery(
        opened.app,
        lease,
        requestOf(api.list, { pagination: { pageSize: size } }),
        holding
      );
    }
    await scheduler.wait(1000);
    await opened.builder.api.apps.members.remove(opened.app, them);
    const owner = clientFor(opened).client;
    await pastAccessRecheck(async () => {
      await vi.waitFor(
        async () => {
          await owner.mutation(api.create, { title: "Again" });
          expect(refusals).toHaveLength(4);
        },
        { timeout: 15_000, interval: 300 }
      );
    });

    const elsewhere = pageFollower();
    await member.api.screens.watchQuery(
      other.app,
      otherLease,
      requestOf(otherApi.list, { pagination: {} }),
      elsewhere.callback
    );
    await eventually(() => {
      expect(titlesOf(elsewhere.received[0])).toStrictEqual([]);
    });
  });

  it("reads afresh for a page that fell behind, rather than keep its result while it catches up", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    // Two notes near a body's bound: a list of them near an answer's.
    for (const title of ["One", "Two"]) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await client.mutation(api.create, { title, body: "x".repeat(100_000) });
    }
    const pushes: Push[][] = [[], []];
    const first = Promise.withResolvers<null>();
    const followerOf = (index: number): ((push: unknown) => void) => {
      // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- core waits for what a page's callback answers
      const callback: (push: unknown) => void = async (push) => {
        const read = pushSchema.parse(push);
        pushes[index]?.push(read);
        if (read.revision === 1) {
          await first.promise;
        }
      };
      return callback;
    };
    const followers = [followerOf(0), followerOf(1)];
    for (const [index, callback] of followers.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await opened.screens.watchQuery(
        opened.app,
        opened.lease,
        requestOf(api.list, { pagination: { pageSize: 10 + index } }),
        callback
      );
    }
    await eventually(() => {
      expect(pushes.map((list) => list.length)).toStrictEqual([1, 1]);
    });
    // A write both read again: past what the page may have waiting.
    await client.mutation(api.create, { title: "Three" });
    await scheduler.wait(1500);
    await silentlyRetitle(opened, "Since then");
    first.resolve(null);

    await eventually(() => {
      for (const list of pushes) {
        expect(titlesOf(list.at(-1))).toStrictEqual([
          "Since then",
          "Since then",
          "Since then",
        ]);
      }
    });
  });
});

/**
 * The Notes App with a table only its builders read and write
 * (`secrets`), and its query and mutation.
 */
const withSecrets = (): Record<string, string> => {
  const schema = files["schema.ts"] ?? "";
  const operations = files["operations/notes.ts"] ?? "";
  const app = files["app.ts"] ?? "";
  return {
    ...files,
    "schema.ts": schema.replace(
      "export default defineSchema({",
      "export default defineSchema({\n  secrets: defineTable({ text: v.string() }),"
    ),
    "operations/notes.ts": `${operations}
export const secrets = query({
  args: {},
  returns: v.array(doc("secrets")),
  handler: async (ctx) => await ctx.db.query("secrets").take(10),
});

export const tell = mutation({
  args: { text: v.string() },
  returns: v.id("secrets"),
  handler: async (ctx, args) => await ctx.db.insert("secrets", args),
});
`,
    "app.ts": app
      .replace(
        "import { create, echo, get, list, remove, update }",
        "import { create, echo, get, list, remove, secrets, tell, update }"
      )
      .replace(
        'access: { tables: { notes: { read: "owner", write: "owner" } } }',
        'access: { tables: { notes: { read: "owner", write: "owner" }, secrets: { read: "appBuilders", write: "appBuilders" } } }'
      )
      .replace(
        "operations: { notes: { list, get, create, update, remove, echo } }",
        "operations: { notes: { list, get, create, update, remove, echo, secrets, tell } }"
      ),
  };
};

describe("live queries and a person's roles", { timeout: 180_000 }, () => {
  it("never pushes what was read for a builder once the person is only a user, even a result that waited", async () => {
    const opened = await openedApp(withSecrets());
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "builder",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    const secrets = referenceTo<Record<never, never>, unknown, "query">(
      opened.release,
      "notes.secrets"
    );
    const tell = referenceTo<{ text: string }, unknown, "mutation">(
      opened.release,
      "notes.tell"
    );
    const received: Push[] = [];
    const first = Promise.withResolvers<null>();
    // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- core waits for what a page's callback answers
    const callback: (push: unknown) => void = async (push) => {
      const read = pushSchema.parse(push);
      received.push(read);
      if (read.revision === 1) {
        await first.promise;
      }
    };
    await member.api.screens.watchQuery(
      opened.app,
      lease,
      requestOf(secrets, {}),
      callback
    );
    await eventually(() => {
      expect(received).toHaveLength(1);
    });
    // A builders' record, read for them while they are one: it waits.
    await clientFor(opened).client.mutation(tell, { text: "Builders only" });
    await scheduler.wait(1500);

    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "user",
    });
    await pastAccessRecheck(async () => {
      first.resolve(null);
      await eventually(() => {
        expect(received.length).toBeGreaterThan(1);
      });
    });
    await scheduler.wait(500);

    expect(
      received.some(({ result }) =>
        JSON.stringify(result).includes("Builders only")
      )
    ).toBeFalsy();
  });
});

describe(
  "live queries and a failure to try again",
  { timeout: 120_000 },
  () => {
    it("follows again after a read that failed before it read anything, rather than push it as final", async () => {
      const opened = await openedApp();
      const api = apiOf(opened.release);
      // A core where no sandbox bounds App code: every read is refused as
      // unavailable, to try again, before it reads the store.
      const { core } = await openRpc(opened.cookie, {
        coreEnv: {
          ...env,
          RUNTIME_PROFILE: "workerd",
          SANDBOX_HOST: undefined,
          SANDBOX_IN_PROCESS: undefined,
        },
      });
      const follower = pageFollower();
      await core
        .authenticate()
        .screens.watchQuery(
          opened.app,
          opened.lease,
          requestOf(api.list, { pagination: {} }),
          follower.callback
        );

      await eventually(() => {
        expect(follower.state.released).toBeTruthy();
      });
      expect(follower.received).toStrictEqual([]);
    });
  }
);

describe(
  "live queries and the room a page leaves",
  { timeout: 120_000 },
  () => {
    it("reads a query held back by what other subscriptions waited on once those are released", async () => {
      const opened = await openedApp();
      const api = apiOf(opened.release);
      const { client } = clientFor(opened);
      // Two notes near a body's bound: a list of them near an answer's.
      for (const title of ["One", "Two"]) {
        // oxlint-disable-next-line no-await-in-loop -- one after the other
        await client.mutation(api.create, { title, body: "x".repeat(100_000) });
      }
      const held = Promise.withResolvers<null>();
      // A page that holds back the first push of each of two queries.
      // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- core waits for what a page's callback answers
      const holding: (push: unknown) => void = async () => {
        await held.promise;
      };
      const subscriptions = [];
      for (const pageSize of [10, 11]) {
        // oxlint-disable-next-line no-await-in-loop -- one after the other
        const subscription = await opened.screens.watchQuery(
          opened.app,
          opened.lease,
          requestOf(api.list, { pagination: { pageSize } }),
          holding
        );
        subscriptions.push(subscription);
      }
      await scheduler.wait(1500);
      // A third: no room left for its first result.
      const third = pageFollower();
      await opened.screens.watchQuery(
        opened.app,
        opened.lease,
        requestOf(api.list, { pagination: { pageSize: 12 } }),
        third.callback
      );
      await scheduler.wait(1500);
      expect(third.received).toStrictEqual([]);

      // The two are released, and the pushes they held finish after.
      await Promise.all(
        subscriptions.map(async (subscription) => {
          await subscription.release();
        })
      );
      held.resolve(null);

      await eventually(() => {
        expect(titlesOf(third.received[0])).toStrictEqual(["Two", "One"]);
      });
    });
  }
);
