import type { OperationReference, ReferenceKind } from "@grasp-os/sdk";
import type { GraspError } from "@grasp-os/sdk/client";
import { clientInternals, GraspClient } from "@grasp-os/sdk/host";
import type { ClientTransport } from "@grasp-os/sdk/host";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import type { Role } from "@grasp-os/shared/roles";
import {
  appFunctionPath,
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { published } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import type { Idp } from "./idp.ts";
import type { apiOf } from "./notes-client-app.ts";
import { notesFiles as files } from "./notes-client-app.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { routed, signedInApi } from "./sign-in.ts";

// What the session client's tests share (screen-client*.test.ts): a Notes
// App's screen opened, the page's transport to core's real
// function route and connection, and how a test reads what a live query
// shows or what a raw subscription was pushed.

/**
 * The IdP the running file signs its people in through. A worker
 * evaluates this module once for every file it runs, so each file mocks
 * its own (`mockSessionIdp`) and its tests use that one.
 */
let currentIdp: Idp | undefined;

/** Mocks the IdP for each test in the calling file, and signs people in through it. */
export const mockSessionIdp = (): Idp => {
  const idp = mockIdp();
  beforeAll(() => {
    currentIdp = idp;
  });
  return idp;
};

export const personApi = async (role: Role) => {
  if (currentIdp === undefined) {
    throw new Error("The test file calls mockSessionIdp()");
  }
  return await signedInApi(currentIdp, role);
};

/**
 * A builder's Notes App, made current, its screen opened by its builder
 * and an admin: the release, the screen's lease, and the builder's session.
 */
export const openedApp = async (appFiles: Record<string, string> = files) => {
  const builder = await personApi("builder");
  const admin = await personApi("admin");
  const { id } = await builder.api.apps.create({ name: "Notes" });
  await published(id);
  const { version } = await builder.api.apps.files.commit(
    id,
    appFiles,
    "First"
  );
  await builder.api.apps.versions.setCurrent(id, version);
  const { lease } = await builder.api.screens.open(id, "notes");
  const { lease: adminLease } = await admin.api.screens.open(id, "notes");
  const release = await loadRelease(env, id, version);
  return {
    app: id,
    lease,
    cookie: builder.session,
    userId: builder.userId,
    release,
    builder,
    screens: builder.api.screens,
    builderId: builder.userId,
    admin: { ...admin, lease: adminLease, cookie: admin.session },
  };
};

export type Opened = Awaited<ReturnType<typeof openedApp>>;

/** Where a page's live queries go: one connection's `screens`. */
export type Screens = Opened["screens"];

/**
 * What the page does with a call the frame sends (apps/web's
 * screen-host.ts): posts it to core's function route under the screen's
 * lease, naming the person it was opened for, answers core's answer, and
 * rejects a refusal with its code; and
 * follows a query over its connection to core (`watchQuery`), the
 * callback's disposal telling the client core let go of it.
 */
export const pageTransport = (
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
    const subscription = await screens
      .frame(app, lease)
      .watchQuery(request, callback);
    return {
      release: () => {
        // oxlint-disable-next-line promise/prefer-await-to-then -- not awaited here
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
  let meanwhile: (() => Promise<unknown>) | undefined;
  let sent = 0;
  return {
    transport: {
      watch: transport.watch,
      call: async (request: string) => {
        sent += 1;
        const answer = await transport.call(request);
        if (dropping > 0) {
          dropping -= 1;
          await meanwhile?.();
          // The request reached core; its answer didn't come back.
          throw new Error("The connection was reset.");
        }
        return answer;
      },
    } satisfies ClientTransport,
    /** Drops the next `count` answers, doing `then` before each is lost. */
    drop: (count: number, then?: () => Promise<unknown>) => {
      dropping = count;
      meanwhile = then;
    },
    /** How many requests reached core so far. */
    sent: () => sent,
  };
};

/**
 * A client over the page's transport, as the frame's runtime mounts it:
 * the builder's, or the admin's with `asAdmin`.
 */
export const clientFor = (
  opened: Opened,
  screens: Screens = opened.screens,
  asAdmin = false
) => {
  const seat = asAdmin
    ? {
        app: opened.app,
        lease: opened.admin.lease,
        cookie: opened.admin.cookie,
        userId: opened.admin.userId,
      }
    : opened;
  const net = network(pageTransport(seat, screens));
  return { client: new GraspClient(net.transport), net };
};

/** The titles of the notes the App holds, newest first. */
export const titles = async (
  client: GraspClient,
  api: ReturnType<typeof apiOf>
) => {
  const page = await client.query(api.list, { pagination: {} });
  return page.items.map((note) => note.title);
};

/**
 * What a component reading a query sees, as `useQuery` subscribes:
 * the shared entry's snapshot, as it is now.
 */
export const reading = (
  client: GraspClient,
  reference: unknown,
  args: unknown
) => {
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
export const eventually = async (look: () => void): Promise<void> => {
  await vi.waitFor(look, pushWait);
};

/** The titles a list snapshot shows, or what it failed with. */
export const shown = (snapshot: {
  value: unknown;
  error: GraspError | undefined;
}) => {
  if (snapshot.error !== undefined) {
    return snapshot.error.code;
  }
  const page = z
    .object({ items: z.array(z.object({ title: z.string() })) })
    .safeParse(snapshot.value);
  return page.success ? page.data.items.map(({ title }) => title) : undefined;
};

/** A query's call as the client sends it, for a raw subscription. */
export const requestOf = (
  reference: OperationReference<unknown, unknown, ReferenceKind>,
  input: unknown,
  kind: ReferenceKind = "query"
): string =>
  JSON.stringify({
    reference: { name: reference.name, kind },
    input,
  });

/**
 * Runs `run` as if `minutes` had passed: following counts as a request,
 * and a person asks an App's screens twenty things at once at most.
 */
export const later = async <T>(
  minutes: number,
  run: () => Promise<T>
): Promise<T> => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + minutes * 60_000 });
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
};

/** The App's store's object. */
export const storeObjectOf = (opened: Opened) => {
  const storeId = opened.release.store?.storeId;
  if (storeId === undefined) {
    throw new Error("The Notes App has a store");
  }
  return inJurisdiction(env, env.DATA_STORES).getByName(storeId);
};

/** A push of core's, as a raw subscription gets it. */
export const pushSchema = z.object({
  revision: z.number(),
  result: z.union([
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
  ]),
});
export type Push = z.infer<typeof pushSchema>;

/**
 * A page's callback for a raw subscription: what reached it, and whether
 * core let go of it.
 */
export const pageFollower = () => {
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
export const titlesOf = (push: Push | undefined): string[] | string | null => {
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
export const silentlyRetitle = async (opened: Opened, title: string) => {
  await runInDurableObject(storeObjectOf(opened), (_store, state) => {
    state.storage.sql.exec(
      "UPDATE sdk_records SET value_json = json_set(value_json, '$.title', ?), revision = revision + 1",
      title
    );
    state.storage.sql.exec("UPDATE sdk_tables SET generation = generation + 1");
  });
};

/** A member of `opened`'s App, with their own screen's lease and client. */
export const memberOf = async (opened: Opened) => {
  const member = await personApi("builder");
  const them = { type: "person", id: member.userId } as const;
  await opened.builder.api.apps.members.add(opened.app, {
    ...them,
    role: "user",
  });
  const { lease } = await member.api.screens.open(opened.app, "notes");
  const { client } = clientFor(
    { ...opened, lease, cookie: member.session, userId: member.userId },
    member.api.screens
  );
  return { member, them, lease, client };
};

/**
 * The Notes App with a table only its builders read and write
 * (`secrets`), and its query and mutation.
 */
export const withSecrets = (): Record<string, string> => {
  const schema = files["server/schema.ts"] ?? "";
  const operations = files["server/notes.ts"] ?? "";
  return {
    ...files,
    "server/schema.ts": schema.replace(
      "export default defineSchema({",
      'export default defineSchema({\n  secrets: defineTable({ text: v.string() }).access({ read: "appBuilders", write: "appBuilders" }),'
    ),
    "server/notes.ts": `${operations}
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
  };
};
