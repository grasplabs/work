import { composioConsentText } from "@grasp-os/shared/connect";
import type {
  ConnectionPerson,
  StartToolkitConnection,
} from "@grasp-os/shared/connect";
import { env, exports } from "cloudflare:workers";
import { beforeEach, vi } from "vite-plus/test";
import { z } from "zod";

import {
  changeToolkitTools,
  reconcileUnsyncedTools,
} from "../src/composio-connections.ts";
import { fakeComposioApi } from "./composio-api.ts";
import { auditEvents, clientOrigin, someone } from "./connect.ts";

// What composio-connections*.test.ts share: the fake Composio, the
// connections made through it, and the walks of the crash tests.

export const contacts = ["contact-1", "contact-2"];

export const composio = fakeComposioApi(
  [
    {
      slug: "hubspot",
      name: "HubSpot",
      tools: [
        { slug: "HUBSPOT_LIST_CONTACTS", inputs: ["pipeline"] },
        { slug: "HUBSPOT_CREATE_CONTACT" },
        { slug: "HUBSPOT_UPDATE_CONTACT" },
      ],
    },
    // Composio holds no app for it: it would take the organization's own.
    {
      slug: "acme_erp",
      name: "Acme ERP",
      managed: false,
      tools: [{ slug: "ACME_ERP_LIST_ORDERS" }],
    },
  ],
  {
    mcpTools: [
      {
        name: "HUBSPOT_LIST_CONTACTS",
        // As Composio's tools do: naming no resources read.
        run: () => ({ output: { contacts } }),
      },
      {
        name: "HUBSPOT_CREATE_CONTACT",
        run: () => ({ output: { id: "contact-3" } }),
      },
      {
        name: "HUBSPOT_UPDATE_CONTACT",
        run: () => ({ output: { deleted: true } }),
      },
    ],
  }
);

export const { events } = auditEvents();

/**
 * Cleanups at Composio connect still has to try, emptied before each test
 * of the file, so each counts its own.
 */
export const composioCleanups = () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM composio_cleanups").run();
  });
  return {
    left: async (): Promise<number> => {
      const counted = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM composio_cleanups"
      ).first<{ n: number }>();
      return counted?.n ?? 0;
    },
  };
};

export const { left: cleanupsLeft } = composioCleanups();

export const allowed = ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_CREATE_CONTACT"];

/** A call of `action` on `connectionId`, with a fresh idempotency key. */
export const call = (connectionId: string, action: string) => ({
  connectionId,
  action,
  input: {},
  idempotencyKey: crypto.randomUUID(),
});

export type Start = Omit<StartToolkitConnection, "person">;

/** Starts connecting HubSpot for `person`, as core does. */
export const start = async (
  person: ConnectionPerson,
  options: Partial<Start> = {}
): Promise<string> => {
  const { url } = await exports.default.startToolkitConnection({
    person,
    toolkit: "hubspot",
    tools: allowed,
    consent: composioConsentText,
    origin: clientOrigin,
    returnTo: "/integrations",
    ...options,
  });
  return url;
};

/** Composio sending `person`'s browser back to core with the flow's state. */
export const back = async (person: ConnectionPerson, state: string) =>
  await exports.default.finishConnection({ person, state });

/** Connects HubSpot end to end for the admin `person`. */
export const connectHubSpot = async (
  person: ConnectionPerson
): Promise<string> => {
  const { state } = composio.authorize(await start(person));
  const { connectionId } = await back(person, state);
  return connectionId;
};

/** The connection as connect's registry holds it. */
export const stored = async (connectionId: string) =>
  await env.DB.prepare(
    "SELECT provider, scope, server_kind AS serverKind, server, account_id AS accountId, composio_server_id AS serverId, tools FROM connections WHERE id = ?"
  )
    .bind(connectionId)
    .first<{
      provider: string;
      scope: string;
      serverKind: string;
      server: string;
      accountId: string;
      serverId: string;
      tools: string;
    }>();

/** What connect made at Composio and didn't delete. */
export const heldAtComposio = () => ({
  authConfigs: composio.state.holds.authConfigs.size,
  accounts: composio.state.holds.accounts.size,
  servers: composio.state.holds.servers.size,
});

/** Nothing connect made is left at Composio. */
export const nothingHeld = { authConfigs: 0, accounts: 0, servers: 0 };

/** Runs `run` as if `minutes` had passed. */
export const afterMinutes = async (
  minutes: number,
  run: () => Promise<void>
): Promise<void> => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + minutes * 60_000);
  try {
    await run();
  } finally {
    clock.mockRestore();
  }
};

/** How many Composio flows of `person` are under way. */
export const flowsOf = async (person: ConnectionPerson): Promise<number> => {
  const counted = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM composio_flows WHERE user_id = ?"
  )
    .bind(person.userId)
    .first<{ n: number }>();
  return counted?.n ?? 0;
};

/**
 * Runs `run` while every `when` (`BEFORE INSERT`, …) write to
 * `composio_cleanups` fails, as a D1 write can.
 */
export const withTrigger = async <Result>(
  when: "BEFORE INSERT" | "BEFORE UPDATE" | "BEFORE DELETE",
  run: () => Promise<Result>
): Promise<Result> => {
  await env.DB.prepare(
    `CREATE TRIGGER fail_cleanups ${when} ON composio_cleanups BEGIN SELECT RAISE(ABORT, 'D1 failed'); END`
  ).run();
  try {
    return await run();
  } finally {
    await env.DB.prepare("DROP TRIGGER fail_cleanups").run();
  }
};

/** Ends the time `person`'s Composio flows had to finish. */
export const expireFlowsOf = async (
  person: ConnectionPerson
): Promise<void> => {
  await env.DB.prepare(
    "UPDATE composio_flows SET expires_at = ? WHERE user_id = ?"
  )
    .bind(Date.now() - 1, person.userId)
    .run();
};

/** Writes connect asked Composio for (anything but reading). */
export const composioWrites = () =>
  composio.state.requests.filter(({ method }) => method !== "GET");

/** A tool as connect stores it: by name, or with its rule. */
export const shownToolsSchema = z.array(
  z.union([
    z.string(),
    z.object({
      name: z.string(),
      read: z.boolean().optional(),
      resource: z.string().optional(),
    }),
  ])
);
export type ShownTool = z.infer<typeof shownToolsSchema>[number];

/** What connect holds `connectionId` allows, as a page shows it. */
export const shownTools = async (
  connectionId: string
): Promise<ShownTool[]> => {
  const row = await env.DB.prepare("SELECT tools FROM connections WHERE id = ?")
    .bind(connectionId)
    .first<{ tools: string | null }>();
  // A connection that isn't there shows a list all the same.
  return shownToolsSchema.parse(
    JSON.parse(row?.tools ?? '["HUBSPOT_LIST_CONTACTS"]')
  );
};

/**
 * Changes the tools of `connectionId` for `person`, as core does, from a
 * page showing what connect holds now unless `expected`.
 */
export const change = async (
  person: ConnectionPerson,
  connectionId: string,
  tools: (string | { name: string; read?: boolean; resource?: string })[],
  expected?: ShownTool[]
) =>
  await exports.default.changeToolkitTools({
    person,
    connectionId,
    tools,
    expected: expected ?? (await shownTools(connectionId)),
  });

/** The allowlist of the one server connect made at Composio. */
export const serverTools = () =>
  [...composio.state.holds.servers.values()].map(
    ({ allowedTools }) => allowedTools
  );

/** Whether connection `connectionId` is out of sync with Composio. */
export const outOfSync = async (connectionId: string): Promise<boolean> => {
  const row = await env.DB.prepare(
    "SELECT tools_sent_seq > tools_settled_seq AS unsynced FROM connections WHERE id = ?"
  )
    .bind(connectionId)
    .first<{ unsynced: number }>();
  return row?.unsynced === 1;
};

/** The stored allowlist of `connectionId`, as connect's registry holds it. */
export const toolsNow = async (connectionId: string) => {
  const row = await stored(connectionId);
  return row?.tools;
};

/** The tool names the `action` events of `recorded` list, in order. */
export const namesIn = (
  recorded: readonly { action: string; detail: Record<string, unknown> }[],
  action: string
) =>
  recorded
    .filter((event) => event.action === action)
    .flatMap(({ detail }) =>
      Object.entries(detail)
        .filter(([key]) => key.startsWith("names"))
        .flatMap(([, value]) => String(value).split(","))
    );

/** Composio updates connect asked for. */
export const updates = () =>
  composio.state.requests.filter(({ method }) => method === "PATCH");

// Composio kept in step with connect's tool list through crashes (GRA-993's
// threat model). Actors share one connection: a change (`a`),
// connect's clock reconciling (`r`) and a second change (`b`). Every send
// to Composio is held at four points: before connect counts it, before
// Composio applies it, after it applied it but before it answers, and
// once answered, before connect records the answer. A walk is the order the actors move from one point
// to the next; an actor no longer moved has crashed there, its send, if
// held before applying, never landing. After every move, Composio may
// differ from connect only while the connection counts as out of sync;
// after the walk and enough time, connect's clock leaves it in sync. A
// sample is walked on every run, from a fixed seed, with the walks that
// once found a fault; CONNECT_WALK_ALL=1 walks every order of a change
// and the clock, and many more drawn with a second change.

/** One send's answer recorded: the statement held at `answered`. */
/**
 * Where connect's side of a send is held: its count and unanswered row,
 * one batch, before it goes out; and its answer recorded.
 */
export const heldStatements =
  /^(?:insert into "composio_tool_sends"|delete from "composio_tool_sends" where .*"seq" = \?)/u;

/**
 * `db`, whose statements matching `held` wait for `gate` before running,
 * alone or in a batch.
 */
export const gatedDb = (
  db: D1Database,
  held: RegExp,
  gate: () => Promise<void>
): D1Database => {
  const real = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const gated = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get: (target, property): unknown => {
        if (property === "bind") {
          return (...values: unknown[]) => gated(target.bind(...values));
        }
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        return async (...args: unknown[]): Promise<unknown> => {
          await gate();
          return Reflect.apply(value, target, args);
        };
      },
    });
    real.set(proxy, statement);
    return proxy;
  };
  return new Proxy(db, {
    get: (target, property): unknown => {
      const value: unknown = Reflect.get(target, property);
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return held.test(query) ? gated(statement) : statement;
        };
      }
      if (property === "batch") {
        return async (
          statements: D1PreparedStatement[]
        ): Promise<D1Result[]> => {
          if (statements.some((statement) => real.has(statement))) {
            await gate();
          }
          return await target.batch(
            statements.map((statement) => real.get(statement) ?? statement)
          );
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
};

/** An actor: what it does, on the `env` its sends are held through. */
export type Actors = Record<string, (actorEnv: Env) => Promise<unknown>>;

/** The tool names connect holds for `connectionId`. */
export const connectNames = async (connectionId: string): Promise<string[]> => {
  const kept = z
    .array(z.union([z.string(), z.object({ name: z.string() })]))
    .parse(JSON.parse((await toolsNow(connectionId)) ?? "[]"));
  return kept.map((tool) => (typeof tool === "string" ? tool : tool.name));
};

/** Whether Composio's server `serverId` allows what connect holds. */
export const inStep = async (connectionId: string, serverId: string) => {
  const atComposio = composio.state.holds.servers.get(serverId);
  const names = await connectNames(connectionId);
  return (
    JSON.stringify([...(atComposio?.allowedTools ?? [])].toSorted()) ===
    JSON.stringify(names.toSorted())
  );
};

/**
 * Walks `walk` for `actors` on connection `connectionId`, from `allowed`
 * in step: what went wrong, if anything, and the actors still able to
 * move after it.
 */
export const walked = async (
  connectionId: string,
  serverId: string,
  actors: Actors,
  walk: readonly string[]
): Promise<{ wrong: string[]; movable: string[] }> => {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE connections SET tools = ?, tools_sent_seq = 0, tools_settled_seq = 0, tools_sync_failures = 0, tools_sync_retry_at = NULL WHERE id = ?"
    ).bind(JSON.stringify(allowed), connectionId),
    env.DB.prepare("DELETE FROM composio_tool_sends"),
  ]);
  const server = composio.state.holds.servers.get(serverId);
  if (server !== undefined) {
    server.allowedTools = [...allowed];
  }
  let moving: string | undefined;
  const held = new Map<string, () => void>();
  const arrived = new Map<string, () => void>();
  const started = new Set<string>();
  const done = new Set<string>();
  const hold = async (): Promise<void> => {
    const actor = moving;
    if (actor === undefined) {
      return;
    }
    const { promise, resolve } = Promise.withResolvers<boolean>();
    held.set(actor, () => {
      resolve(true);
    });
    arrived.get(actor)?.();
    await promise;
  };
  composio.state.updateGate = hold;
  const wrong: string[] = [];
  try {
    for (const actor of walk) {
      // A move of an actor that ended changes nothing.
      if (done.has(actor)) {
        continue;
      }
      moving = actor;
      const { promise, resolve } = Promise.withResolvers<boolean>();
      arrived.set(actor, () => {
        resolve(true);
      });
      const release = held.get(actor);
      held.delete(actor);
      if (release !== undefined) {
        release();
      } else if (!started.has(actor)) {
        started.add(actor);
        const run = actors[actor];
        const actorEnv = {
          ...env,
          DB: gatedDb(env.DB, heldStatements, hold),
        };
        void (async () => {
          try {
            await run?.(actorEnv);
          } catch {
            // A refused change is one way it ends.
          }
          done.add(actor);
          arrived.get(actor)?.();
        })();
      }
      // oxlint-disable-next-line no-await-in-loop -- one move at a time
      await promise;
      moving = undefined;
      // oxlint-disable-next-line no-await-in-loop -- checked after each move
      const differs = !(await inStep(connectionId, serverId));
      // oxlint-disable-next-line no-await-in-loop -- checked after each move
      if (differs && !(await outOfSync(connectionId))) {
        wrong.push(`differs unmarked after ${walk.join(" ")}`);
      }
    }
    const movable = Object.keys(actors).filter((actor) => !done.has(actor));
    // The rest crashed where they are. Time passes: the clock settles it.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (let run = 0; run < 3; run += 1) {
        vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);
        // oxlint-disable-next-line no-await-in-loop -- one clock run at a time
        await reconcileUnsyncedTools(env);
      }
    } finally {
      vi.useRealTimers();
    }
    if (!(await inStep(connectionId, serverId))) {
      wrong.push(`never repaired after ${walk.join(" ")}`);
    }
    if (await outOfSync(connectionId)) {
      wrong.push(`still out of sync after ${walk.join(" ")}`);
    }
    return { wrong, movable };
  } finally {
    composio.state.updateGate = undefined;
  }
};

/**
 * Thousands of sends in seconds: each one's wait for an answer would hold
 * a timer for ten seconds, past the isolate's limit on timers.
 */
export const untimed = () => {
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(
    new AbortController().signal
  );
};

/** Whether to walk every order (`CONNECT_WALK_ALL=1`, vite.config.ts). */
export const walkAll = z
  .object({ CONNECT_WALK_ALL: z.literal("1") })
  .safeParse(env).success;

/** How a sample of walks is drawn. */
export interface Draw {
  /** The walks always walked: ones that found a fault before. */
  fixed: readonly (readonly string[])[];
  seed: number;
  count: number;
  /** Most moves a drawn walk has. */
  longest: number;
}

/**
 * The `fixed` walks of `actors`, then `count` drawn from `seed`: each up
 * to `longest` moves of actors picked at random, each actor crashing
 * wherever its moves end. What went wrong.
 */
export const drawnWalks = async (
  connectionId: string,
  serverId: string,
  actors: Actors,
  { fixed, seed, count, longest }: Draw
): Promise<string[]> => {
  untimed();
  // A linear congruential generator: the same walks on every run.
  let state = seed;
  const draw = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const names = Object.keys(actors);
  const drawn = Array.from({ length: count }, () =>
    Array.from(
      { length: Math.floor(draw() * (longest + 1)) },
      () => names[Math.floor(draw() * names.length)] ?? ""
    )
  );
  const wrong: string[] = [];
  for (const walk of [...fixed, ...drawn]) {
    // oxlint-disable-next-line no-await-in-loop -- each walk on its own
    const result = await walked(connectionId, serverId, actors, walk);
    wrong.push(...result.wrong);
  }
  return wrong;
};

/** Every walk of `actors`, each actor crashing anywhere or finishing. */
export const everyWalk = async (
  connectionId: string,
  serverId: string,
  actors: Actors
): Promise<string[]> => {
  const wrong: string[] = [];
  const pending: string[][] = [[]];
  untimed();
  while (pending.length > 0) {
    const walk = pending.pop() ?? [];
    // oxlint-disable-next-line no-await-in-loop -- each walk on its own
    const result = await walked(connectionId, serverId, actors, walk);
    wrong.push(...result.wrong);
    for (const actor of result.movable) {
      pending.push([...walk, actor]);
    }
  }
  return wrong;
};

/** A change of `connectionId` to `tools`, by `admin`. */
export const changeTo =
  (admin: ConnectionPerson, connectionId: string, tools: string[]) =>
  async (actorEnv: Env) =>
    await changeToolkitTools(actorEnv, {
      person: admin,
      connectionId,
      tools,
      expected: await shownTools(connectionId),
    });

export const setUp = async () => {
  const admin = someone("admin");
  const connectionId = await connectHubSpot(admin);
  await env.DB.prepare(
    "UPDATE connections SET tools_settled_seq = tools_sent_seq WHERE id != ?"
  )
    .bind(connectionId)
    .run();
  const row = await stored(connectionId);
  return { admin, connectionId, serverId: row?.serverId ?? "" };
};
