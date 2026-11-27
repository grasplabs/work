/**
 * A stand-in for Composio, the outside system connect calls for the
 * catalog and for Composio connections: its REST API, as Composio
 * documents it, and the sessions it makes, each one's MCP endpoint a real
 * MCP server (test/mcp-server.ts). Its legacy per-server MCP API isn't
 * served: any request to it fails the test (`legacyRequests`). It answers connect's outbound requests to
 * Composio's host, so connect runs unchanged. Tests choose the toolkits and
 * tools it has, whether it is up, and how an admin fares at its auth link,
 * and read back what connect asked of it and what it holds.
 */
import { afterEach, beforeEach, vi } from "vite-plus/test";

import { forgetComposioCatalog } from "../src/catalog.ts";
import { composioApiBase } from "../src/composio.ts";
import { forgetCatalogLogos } from "../src/logos.ts";
import { mcpServerWith } from "./mcp-server.ts";
import type { FakeTool } from "./mcp-server.ts";
import { testComposioKey } from "./provider-config.ts";

export interface FakeComposioTool {
  slug: string;
  description?: string;
  /** The properties its input takes. */
  inputs?: string[];
  /**
   * Its behaviour tags, such as `readOnlyHint`; by default the item has no
   * `tags` at all. Anything but strings stands for an answer of Composio's
   * that connect can't read.
   */
  tags?: unknown;
  /**
   * Composio's `is_deprecated`: false by default, as Composio sends it for
   * every tool. Anything but a boolean stands for a mark connect can't read.
   */
  isDeprecated?: unknown;
}

/** One field of a toolkit's key auth, as Composio describes it. */
export interface FakeKeyField {
  name: string;
  displayName?: string;
  description?: string;
  /** Whether it is in the required list; by default yes. */
  required?: boolean;
  /** Composio's `is_secret`; left out when undefined. */
  secret?: boolean;
  /** Composio's `user_visible`; by default yes. */
  visible?: boolean;
}

/** How a toolkit takes a key, and which values its provider accepts. */
export interface FakeKeyAuth {
  scheme: "API_KEY" | "BEARER_TOKEN" | "BASIC";
  fields: FakeKeyField[];
  /**
   * What the provider checks, by field name: a connected account made with
   * any other value is refused, as Composio refuses one the provider
   * rejected.
   */
  accepts: Record<string, string>;
  /**
   * A field of the list named that connect can't read (its `displayName`
   * isn't text), described after the others, if any.
   */
  unreadable?: "required" | "optional";
}

export interface FakeToolkit {
  slug: string;
  name: string;
  /** Whether Composio holds an app for it (managed auth); by default yes. */
  managed?: boolean;
  /** How it takes a key too, if it does. */
  keyAuth?: FakeKeyAuth;
  categories?: string[];
  /**
   * What its list says it is: `<name> toolkit` by default, `null` for no
   * description at all. Anything but a string stands for an answer of
   * Composio's that connect can't read.
   */
  description?: unknown;
  tools: FakeComposioTool[];
  /**
   * Where its list says its logo is: on Composio's logo host by default,
   * `null` for no address at all.
   */
  logo?: string | null;
}

/** One request connect sent to the API. */
export interface ComposioApiRequest {
  method: string;
  /** Its path under the API's base, with its query. */
  path: string;
  /** Whether it carried connect's key, in `x-api-key`. */
  keyed: boolean;
  /** Whether it would follow a redirect. */
  followsRedirects: boolean;
}

/**
 * How the API answers: `up`; `down` (a 503 to everything); `redirect` (a
 * 302 to another host); `garbled` (a 200 that isn't JSON); `huge` (a 200
 * streaming a valid page of 6 MiB, `hugeAnswerBytes`); `refusing` (a 400,
 * as to a toolkit it doesn't know); `stuck` (a 503 whose body fails when
 * connect cancels it).
 */
export type ComposioHealth =
  | "up"
  | "down"
  | "redirect"
  | "garbled"
  | "huge"
  | "refusing"
  | "stuck";

/** What the API answers to everything while it isn't up. */
const failures: Partial<Record<ComposioHealth, () => Response>> = {
  down: () => new Response("Service Unavailable", { status: 503 }),
  redirect: () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://elsewhere.example/api" },
    }),
  garbled: () => new Response("<html>", { status: 200 }),
  stuck: () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull: (controller) => {
          controller.enqueue(new Uint8Array(16));
        },
        cancel: () => {
          throw new Error("The connection broke");
        },
      }),
      { status: 503 }
    ),
  refusing: () =>
    Response.json({ error: { message: "Toolkit not found" } }, { status: 400 }),
};

const hugeHead = new TextEncoder().encode(
  '{"items":[],"next_cursor":null,"pad":"'
);
const hugeTail = new TextEncoder().encode('"}');
// Of `a` (0x61).
const hugeChunk = new Uint8Array(64 * 1024).fill(0x61);
const hugeChunks = 96;

/**
 * Bytes in the `huge` answer: an empty page of the list, valid JSON, that
 * pads it past connect's 4 MiB cap to 6 MiB.
 */
export const hugeAnswerBytes =
  hugeHead.byteLength + hugeChunks * hugeChunk.byteLength + hugeTail.byteLength;

/**
 * The `huge` answer, in chunks and without a `content-length`, sent only
 * as fast as it is read: `sent` counts the bytes read so far.
 */
const hugeAnswer = (sent: { bytes: number }): Response => {
  let next = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull: (controller) => {
        let chunk: Uint8Array | undefined = hugeChunk;
        if (next === 0) {
          chunk = hugeHead;
        } else if (next === hugeChunks + 1) {
          chunk = hugeTail;
        } else if (next > hugeChunks + 1) {
          chunk = undefined;
        }
        next += 1;
        if (chunk === undefined) {
          controller.close();
          return;
        }
        sent.bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    })
  );
};

/** Where Composio serves toolkits' logos. */
const logoHost = "logos.composio.dev";

/** The smallest PNG there is: a signature and a one-pixel image. */
export const pngLogo = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
  ),
  (char) => char.codePointAt(0) ?? 0
);

/** One request connect sent to the logo host. */
export interface LogoRequest {
  path: string;
  /** Whether it carried connect's key, in `x-api-key`. */
  keyed: boolean;
  followsRedirects: boolean;
}

/** Items per page: few, so a short list takes more than one. */
const fakePageSize = 2;

/**
 * Where Composio serves a session's MCP endpoint: `<base><session id>/mcp`,
 * on its API host (`POST /tool_router/session`'s `mcp.url`).
 */
export const sessionUrlBase =
  "https://backend.composio.dev/api/v3/tool_router/session/";

/** Where Composio's legacy API served the MCP servers it made. */
const legacyMcpBase = "https://backend.composio.dev/v3/mcp/";

const toolkitItem = ({
  slug,
  name,
  managed,
  keyAuth,
  categories,
  description = `${name} toolkit`,
  tools,
  logo = `https://${logoHost}/api/${slug}`,
}: FakeToolkit) => ({
  slug,
  name,
  type: "native",
  // In lower case, as Composio's toolkit list names schemes.
  auth_schemes:
    keyAuth === undefined
      ? ["oauth2"]
      : ["oauth2", keyAuth.scheme.toLowerCase()],
  composio_managed_auth_schemes: managed === false ? [] : ["oauth2"],
  no_auth: false,
  meta: {
    ...(description === null ? {} : { description }),
    ...(logo === null ? {} : { logo }),
    categories: (categories ?? []).map((category) => ({
      id: category.toLowerCase(),
      name: category,
    })),
    tools_count: tools.length,
    triggers_count: 0,
  },
});

/**
 * One page of `items`, from the cursor on, as Composio pages its lists;
 * `endless` pages never end.
 */
const page = (
  items: readonly unknown[],
  cursor: string | null,
  endless = false
): Response => {
  const start = cursor === null ? 0 : Number(cursor);
  const next = start + fakePageSize;
  return Response.json({
    items: items.slice(start, next),
    next_cursor: endless || next < items.length ? String(next) : null,
    total_items: items.length,
  });
};

const notFound = (): Response =>
  Response.json({ error: { message: "Not found" } }, { status: 404 });

/** One field as Composio's toolkit description lists it. */
const fieldItem = ({
  name,
  displayName = name,
  description = `Your ${name}`,
  required = true,
  secret,
  visible = true,
}: FakeKeyField) => ({
  name,
  displayName,
  type: "string",
  description,
  required,
  user_visible: visible,
  ...(secret === undefined ? {} : { is_secret: secret }),
});

/** One scheme of a toolkit's auth, as Composio describes it. */
const authDetail = (
  mode: string,
  initiation: { required: unknown[]; optional: unknown[] }
) => ({
  mode,
  name: mode,
  required_scopes: [],
  is_connection_revoke_supported: false,
  fields: {
    auth_config_creation: { required: [], optional: [] },
    connected_account_initiation: initiation,
  },
});

/** A field connect can't read: its `displayName` isn't text. */
const unreadableField = {
  name: "unreadable",
  displayName: 42,
  type: "string",
  description: "Not one connect can read",
  required: true,
  user_visible: true,
};

/** A toolkit, as Composio describes it alone: its auth, scheme by scheme. */
const toolkitDetail = ({ slug, name, keyAuth }: FakeToolkit) => {
  const fields = keyAuth?.fields ?? [];
  const unreadable = (list: "required" | "optional") =>
    keyAuth?.unreadable === list ? [unreadableField] : [];
  return {
    slug,
    name,
    auth_config_details: [
      authDetail("OAUTH2", { required: [], optional: [] }),
      ...(keyAuth === undefined
        ? []
        : [
            authDetail(keyAuth.scheme, {
              required: [
                ...fields
                  .filter(({ required }) => required !== false)
                  .map(fieldItem),
                ...unreadable("required"),
              ],
              optional: [
                ...fields
                  .filter(({ required }) => required === false)
                  .map(fieldItem),
                ...unreadable("optional"),
              ],
            }),
          ]),
    ],
  };
};

/**
 * Composio's answer to a read of the catalog of `toolkits`: their list
 * (`GET /toolkits`), one toolkit (`GET /toolkits/{slug}`) or its tools
 * (`GET /tools`), or undefined for any other request.
 */
const catalogAnswer = (
  toolkits: readonly FakeToolkit[],
  request: Request
): Response | undefined => {
  const url = new URL(request.url);
  const route = url.pathname.slice(new URL(composioApiBase).pathname.length);
  if (request.method !== "GET") {
    return undefined;
  }
  if (route === "/toolkits") {
    return page(toolkits.map(toolkitItem), url.searchParams.get("cursor"));
  }
  if (route.startsWith("/toolkits/")) {
    const toolkit = toolkits.find(({ slug }) => route === `/toolkits/${slug}`);
    return toolkit === undefined
      ? notFound()
      : Response.json(toolkitDetail(toolkit));
  }
  if (route !== "/tools") {
    return undefined;
  }
  const toolkit = toolkits.find(
    ({ slug }) => slug === url.searchParams.get("toolkit_slug")
  );
  return page(
    (toolkit?.tools ?? []).map(
      ({ slug, description, inputs = [], tags, isDeprecated = false }) => ({
        slug,
        name: slug,
        description,
        toolkit: { slug: toolkit?.slug, name: toolkit?.name },
        input_parameters: {
          type: "object",
          properties: Object.fromEntries(
            inputs.map((input) => [input, { type: "string" }])
          ),
        },
        tags,
        is_deprecated: isDeprecated,
      })
    ),
    url.searchParams.get("cursor")
  );
};

/** An auth config connect made: Composio's app for one toolkit, or its own. */
export interface FakeAuthConfig {
  toolkit: string;
  managed: boolean;
  name: string | null;
  /** The scheme of one of connect's own (`use_custom_auth`). */
  scheme: string | null;
  /** The credentials it was made with. */
  credentials: unknown;
}

/** A connected account connect made, and how its auth went. */
export interface FakeAccount {
  authConfigId: string;
  toolkit: string;
  userId: string;
  callbackUrl: string;
  redirectUrl: string;
  status: "INITIATED" | "ACTIVE" | "FAILED";
  /**
   * How many more reads see it still `INITIATED` before its `status`: an
   * account Composio is still completing after its redirect.
   */
  pendingReads: number;
  /** The scheme and values it was made with, when made with a key. */
  state?: { authScheme: unknown; val: unknown };
}

/** A session connect made, as Composio holds its config. */
export interface FakeSession {
  userId: string;
  /** The toolkits it enables (`toolkits.enable`). */
  toolkits: string[];
  /** Its auth configs, by toolkit. */
  authConfigs: Record<string, string>;
  /** The connected accounts pinned to it, by toolkit. */
  connectedAccounts: Record<string, string[]>;
  /** The tools it allows of its toolkit (`tools.<toolkit>.enable`). */
  allowedTools: string[];
  /** The rest of what it was made with, as sent. */
  body: Record<string, unknown>;
  /** Up by one with each change (`config_version`). */
  configVersion: number;
}

interface Holdings {
  authConfigs: Map<string, FakeAuthConfig>;
  accounts: Map<string, FakeAccount>;
  sessions: Map<string, FakeSession>;
}

const bodyOf = async (request: Request): Promise<Record<string, unknown>> => {
  const body: unknown = await request.json();
  return typeof body === "object" && body !== null
    ? Object.fromEntries(Object.entries(body))
    : {};
};

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((each): each is string => typeof each === "string")
    : [];

const nested = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Object.entries(value).find(([name]) => name === key)?.[1]
    : undefined;

/**
 * Whether Composio's own tool for `area` is on in a session made with
 * `body`, as Composio's defaults have it when the body leaves it out: on
 * (`manage_connections`, `search`, `workbench`), off (`proxy_execute`,
 * outside the workbench), or an object (`instant`, usage with Composio's
 * own accounts).
 */
const switchedOn = (body: Record<string, unknown>, area: string): boolean => {
  const given = nested(body, area);
  if (area === "instant") {
    return given !== false;
  }
  const enable = nested(given, "enable");
  return area === "proxy_execute" ? enable === true : enable !== false;
};

/** The entries of `value`, an object, or none. */
const entriesOf = (value: unknown): [string, unknown][] =>
  typeof value === "object" && value !== null ? Object.entries(value) : [];

/** Composio's error answer for a request it can't take, with `message`. */
const invalid = (message: string): Response =>
  Response.json(
    { error: { message, code: 1400, slug: "BadRequest", status: 400 } },
    { status: 400 }
  );

/**
 * Composio with `toolkits`, for each test in the file. `extra` are items
 * listed with the toolkits as they are, such as ones connect can't read.
 * Every MCP server it makes has the tools `mcpTools`, as Composio's would
 * have its toolkit's; the server's own allowlist isn't applied, so the
 * tests see what connect lets through.
 */
export const fakeComposioApi = (
  toolkits: readonly FakeToolkit[],
  {
    extra = [],
    mcpTools = [],
  }: { extra?: readonly unknown[]; mcpTools?: readonly FakeTool[] } = {}
) => {
  const mcp = mcpServerWith(mcpTools);
  const state: {
    /** Every request connect sent to the API, in order. */
    requests: ComposioApiRequest[];
    health: ComposioHealth;
    /** Bytes of the `huge` answer read so far. */
    hugeSent: { bytes: number };
    /** Its toolkit list never ends: every page says there is another. */
    endless: boolean;
    /** The status its tool lists answer with instead, if any. */
    toolsStatus: number | undefined;
    /**
     * Requests that answer 503: those whose method and path under the
     * API's base start with this, such as `DELETE /connected_accounts/`.
     */
    failing: string | undefined;
    /**
     * As `failing`, for its next `times` requests only, each counted down
     * as it fails: a failure that passes. It answers `status` (503 by
     * default) with Composio's error envelope, its `code` when given (403
     * names 1001 by default, as a key without the route's permission), or,
     * `broken`, 200 with a body that breaks off after its first bytes.
     */
    failingFor:
      | {
          prefix: string;
          times: number;
          broken?: boolean;
          status?: number;
          /** Composio's number for the error; `null` sends none. */
          code?: number | null;
          /** Composio's name for the error; `null` sends none. */
          slug?: string | null;
        }
      | undefined;
    /**
     * How its answers about an account write the toolkit's slug: as it is,
     * in capitals, or with each `k` the Kelvin sign (U+212A), which
     * Unicode lowers to `k`.
     */
    slugCase: "lower" | "upper" | "kelvin";
    /** Where it says a new session's MCP endpoint is, `<base><id>/mcp`. */
    sessionUrlBase: string;
    /**
     * What it answers of a session it made, in place of its config as held:
     * a test's Composio that answers for another user, say.
     */
    answeredConfig:
      | ((config: Record<string, unknown>) => Record<string, unknown>)
      | undefined;
    /**
     * Requests to Composio's legacy per-server MCP API (`/mcp/...`), which
     * connect never sends: any fails the test.
     */
    legacyRequests: string[];
    /** What connect made at Composio and hasn't deleted. */
    holds: Holdings;
    /** Every request connect sent to the logo host, in order. */
    logoRequests: LogoRequest[];
    /**
     * How the logo host answers for a toolkit, by its slug: the PNG
     * `pngLogo` for any other.
     */
    logos: Map<string, () => Response>;
    /** The sessions' MCP requests and tool runs, all of them together. */
    mcp: typeof mcp.state;
    /**
     * Runs as it takes a session's update, before applying it: another
     * change landing in between, once.
     */
    beforeUpdate: (() => Promise<void>) | undefined;
    /**
     * Awaited as it takes a session's update: before applying it
     * (`"apply"`), and after, before answering (`"answer"`). A test holds a
     * send there, or drops it there for good, as a crash would.
     */
    updateGate: ((at: "apply" | "answer") => Promise<void>) | undefined;
    /**
     * Awaited as it takes the making of a session, before making it: a
     * test holds two connects there, past everything before it.
     */
    sessionGate: (() => Promise<void>) | undefined;
  } = {
    requests: [],
    health: "up",
    hugeSent: { bytes: 0 },
    endless: false,
    toolsStatus: undefined,
    failing: undefined,
    failingFor: undefined,
    slugCase: "lower",
    sessionUrlBase,
    answeredConfig: undefined,
    legacyRequests: [],
    holds: { authConfigs: new Map(), accounts: new Map(), sessions: new Map() },
    logoRequests: [],
    logos: new Map(),
    mcp: mcp.state,
    beforeUpdate: undefined,
    updateGate: undefined,
    sessionGate: undefined,
  };

  /** The logo host's answer, as `state.logos` has it. */
  const logoAnswer = (request: Request): Response => {
    const url = new URL(request.url);
    state.logoRequests.push({
      path: url.pathname,
      keyed: request.headers.has("x-api-key"),
      followsRedirects: request.redirect === "follow",
    });
    const slug = url.pathname.slice("/api/".length);
    return (
      state.logos.get(slug)?.() ??
      new Response(pngLogo, { headers: { "content-type": "image/png" } })
    );
  };

  /**
   * A session's answer, as Composio gives it to making or changing one:
   * its ID, MCP endpoint, tools and config, the toolkits' Composio tools
   * echoed as on or off (`switchedOn`), unless `state.answeredConfig`
   * answers otherwise.
   */
  const sessionAnswer = (
    sessionId: string,
    session: FakeSession,
    status: number
  ): Response => {
    const { body } = session;
    const config: Record<string, unknown> = {
      user_id: session.userId,
      toolkits: { enabled: session.toolkits },
      auth_configs: session.authConfigs,
      connected_accounts: session.connectedAccounts,
      tools: Object.fromEntries(
        session.toolkits.map((toolkit) => [
          toolkit,
          { enabled: session.allowedTools },
        ])
      ),
      manage_connections: { enabled: switchedOn(body, "manage_connections") },
      search: { enable: switchedOn(body, "search") },
      workbench: { enable: switchedOn(body, "workbench") },
      proxy_execute: { enable: switchedOn(body, "proxy_execute") },
      instant: switchedOn(body, "instant") ? {} : false,
      preload: nested(body, "preload") ?? { tools: [] },
      execute: nested(body, "execute") ?? { enable_multi_execute: true },
    };
    return Response.json(
      {
        session_id: sessionId,
        mcp: { type: "http", url: `${state.sessionUrlBase}${sessionId}/mcp` },
        tool_router_tools: session.allowedTools,
        config: state.answeredConfig?.(config) ?? config,
        config_version: session.configVersion,
      },
      { status }
    );
  };

  /**
   * The tools `tools` (a session's `tools`) enable of `toolkit`, if each is
   * one of the toolkit's, as Composio requires: `undefined` when one isn't,
   * or when it enables none, which Composio may take for every tool, and
   * connect never sends.
   */
  const enabledTools = (
    tools: unknown,
    toolkit: string
  ): string[] | undefined => {
    const names = stringsOf(nested(nested(tools, toolkit), "enable"));
    const known = new Set(
      toolkits
        .find(({ slug }) => slug === toolkit)
        ?.tools.map(({ slug }) => slug)
    );
    return names.length > 0 && names.every((name) => known.has(name))
      ? names
      : undefined;
  };

  /**
   * Makes a session as Composio does (`POST /tool_router/session`): each
   * pinned account must exist and be the session user's, at most one a
   * toolkit, and each tool one of its toolkit's.
   */
  const makeSession = (body: Record<string, unknown>): Response => {
    const userId = nested(body, "user_id");
    if (typeof userId !== "string" || userId === "") {
      return invalid("user_id is required");
    }
    const sessionToolkits = stringsOf(
      nested(nested(body, "toolkits"), "enable")
    );
    const pinned = Object.fromEntries(
      entriesOf(nested(body, "connected_accounts")).map(([toolkit, ids]) => [
        toolkit,
        stringsOf(ids),
      ])
    );
    for (const ids of Object.values(pinned)) {
      if (ids.length > 1) {
        return invalid("Only one connected account per toolkit");
      }
      for (const id of ids) {
        if (state.holds.accounts.get(id)?.userId !== userId) {
          return invalid("The connected account isn't the session user's");
        }
      }
    }
    const [toolkit = ""] = sessionToolkits;
    const allowedTools = enabledTools(nested(body, "tools"), toolkit);
    if (allowedTools === undefined) {
      return invalid("Unknown tool slugs");
    }
    const sessionId = `trs_${crypto.randomUUID()}`;
    const session: FakeSession = {
      userId,
      toolkits: sessionToolkits,
      authConfigs: Object.fromEntries(
        entriesOf(nested(body, "auth_configs")).map(([key, value]) => [
          key,
          String(value),
        ])
      ),
      connectedAccounts: pinned,
      allowedTools,
      body,
      configVersion: 1,
    };
    state.holds.sessions.set(sessionId, session);
    return sessionAnswer(sessionId, session, 201);
  };

  /**
   * Changes a session's tools as Composio does
   * (`PATCH /tool_router/session/{id}`): what the body leaves out stays.
   */
  const updateSession = async (
    request: Request,
    sessionId: string
  ): Promise<Response> => {
    const session = state.holds.sessions.get(sessionId);
    if (session === undefined) {
      return notFound();
    }
    const before = state.beforeUpdate;
    state.beforeUpdate = undefined;
    await before?.();
    const body = await bodyOf(request);
    const [toolkit = ""] = session.toolkits;
    const allowedTools = enabledTools(nested(body, "tools"), toolkit);
    if (allowedTools === undefined) {
      return invalid("Unknown tool slugs");
    }
    await state.updateGate?.("apply");
    session.allowedTools = allowedTools;
    session.configVersion += 1;
    await state.updateGate?.("answer");
    return sessionAnswer(sessionId, session, 200);
  };

  /** What connect creates at Composio, by route, from the request's body. */
  const creations: Record<
    string,
    (body: Record<string, unknown>) => Response | Promise<Response>
  > = {
    "/auth_configs": (body) => {
      const toolkit = String(nested(body.toolkit, "slug"));
      if (!toolkits.some(({ slug }) => slug === toolkit)) {
        return notFound();
      }
      const authConfigId = `ac_${crypto.randomUUID()}`;
      const type = nested(body.auth_config, "type");
      const scheme = nested(body.auth_config, "authScheme");
      if (type === "use_custom_auth" && typeof scheme !== "string") {
        return Response.json(
          { error: { message: "authScheme is required", slug: "Invalid" } },
          { status: 400 }
        );
      }
      state.holds.authConfigs.set(authConfigId, {
        toolkit,
        managed: type === "use_composio_managed_auth",
        name:
          typeof nested(body.auth_config, "name") === "string"
            ? String(nested(body.auth_config, "name"))
            : null,
        scheme: typeof scheme === "string" ? scheme : null,
        credentials: nested(body.auth_config, "credentials"),
      });
      return Response.json(
        { toolkit: { slug: toolkit }, auth_config: { id: authConfigId } },
        { status: 201 }
      );
    },
    "/connected_accounts/link": (body) => {
      const authConfigId = String(body.auth_config_id);
      const authConfig = state.holds.authConfigs.get(authConfigId);
      if (authConfig === undefined) {
        return notFound();
      }
      const accountId = `ca_${crypto.randomUUID()}`;
      const redirectUrl = `https://connect.composio.dev/link/${accountId}`;
      state.holds.accounts.set(accountId, {
        authConfigId,
        toolkit: authConfig.toolkit,
        userId: String(body.user_id),
        callbackUrl: String(body.callback_url),
        redirectUrl,
        status: "INITIATED",
        pendingReads: 0,
      });
      return Response.json(
        {
          link_token: "link-token",
          redirect_url: redirectUrl,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          connected_account_id: accountId,
        },
        { status: 201 }
      );
    },
    "/connected_accounts": (body) => {
      const authConfigId = String(nested(body.auth_config, "id"));
      const authConfig = state.holds.authConfigs.get(authConfigId);
      if (authConfig === undefined) {
        return notFound();
      }
      const connection = nested(body, "connection");
      const given = nested(connection, "state");
      const authScheme = nested(given, "authScheme");
      const val = nested(given, "val");
      const keyAuth = toolkits.find(
        ({ slug }) => slug === authConfig.toolkit
      )?.keyAuth;
      if (
        authConfig.managed ||
        authScheme !== authConfig.scheme ||
        nested(val, "status") !== "ACTIVE"
      ) {
        return Response.json(
          { error: { message: "Invalid state", slug: "Invalid" } },
          { status: 400 }
        );
      }
      const accepted = Object.entries(keyAuth?.accepts ?? {}).every(
        ([name, value]) => nested(val, name) === value
      );
      if (!accepted) {
        // As Composio's answer may: what was sent, in its message.
        return Response.json(
          {
            error: {
              message: `The provider rejected ${JSON.stringify(val)}`,
              code: 1801,
              slug: "ConnectedAccount_CredentialValidationRejected",
              status: 400,
            },
          },
          { status: 400 }
        );
      }
      const accountId = `ca_${crypto.randomUUID()}`;
      state.holds.accounts.set(accountId, {
        authConfigId,
        toolkit: authConfig.toolkit,
        userId: String(nested(connection, "user_id")),
        callbackUrl: "",
        redirectUrl: "",
        status: "ACTIVE",
        pendingReads: 0,
        state: { authScheme, val },
      });
      return Response.json(
        {
          id: accountId,
          connectionData: { authScheme, val: { status: "ACTIVE" } },
          status: "ACTIVE",
          redirect_url: null,
          redirect_uri: null,
        },
        { status: 201 }
      );
    },
    "/tool_router/session": async (body) => {
      await state.sessionGate?.();
      return makeSession(body);
    },
  };

  /** A deletion of something connect made, by route. */
  const deletion = (route: string): Response => {
    const session = /^\/tool_router\/session\/(?<id>[^/]+)$/u.exec(route)
      ?.groups?.id;
    if (session !== undefined) {
      return state.holds.sessions.delete(session)
        ? Response.json({ session_id: session, deleted: true })
        : notFound();
    }
    const [, area, id] = route.split("/");
    const held = {
      auth_configs: state.holds.authConfigs,
      connected_accounts: state.holds.accounts,
    }[area ?? ""];
    return held?.delete(id ?? "") === true
      ? Response.json({ success: true })
      : notFound();
  };

  /** A connected account, as Composio shows it. */
  const accountAt = (route: string): Response => {
    const id = route.slice("/connected_accounts/".length);
    const account = state.holds.accounts.get(id);
    if (account === undefined) {
      return notFound();
    }
    const completing = account.pendingReads > 0;
    account.pendingReads = Math.max(account.pendingReads - 1, 0);
    return Response.json({
      id,
      status: completing ? "INITIATED" : account.status,
      toolkit: {
        slug: {
          lower: account.toolkit,
          upper: account.toolkit.toUpperCase(),
          kelvin: account.toolkit.replaceAll("k", "\u212A"),
        }[state.slugCase],
      },
      auth_config: { id: account.authConfigId },
    });
  };

  /**
   * Lists of what connect made, as Composio filters them: auth configs by
   * a search of their name, and connected accounts by their auth configs.
   */
  const listing = (route: string, query: URLSearchParams): Response => {
    const { holds } = state;
    const search = query.get("search") ?? "";
    const byAuthConfig = query.get("auth_config_ids");
    const lists: Record<string, { id: string; name?: string | null }[]> = {
      "/auth_configs": [...holds.authConfigs]
        .filter(([, { name }]) => (name ?? "").includes(search))
        .map(([id, { name }]) => ({ id, name })),
      "/connected_accounts": [...holds.accounts]
        .filter(([, { authConfigId }]) => authConfigId === byAuthConfig)
        .map(([id]) => ({ id })),
    };
    const items = lists[route];
    return items === undefined
      ? notFound()
      : Response.json({ items, next_cursor: null });
  };

  const manage = async (
    request: Request,
    route: string,
    query: URLSearchParams
  ): Promise<Response> => {
    if (request.method === "DELETE") {
      return deletion(route);
    }
    const patched = /^\/tool_router\/session\/(?<id>[^/]+)$/u.exec(route)
      ?.groups?.id;
    if (request.method === "PATCH" && patched !== undefined) {
      return await updateSession(request, patched);
    }
    if (
      request.method === "GET" &&
      ["/auth_configs", "/connected_accounts"].includes(route)
    ) {
      return listing(route, query);
    }
    if (request.method === "GET" && route.startsWith("/connected_accounts/")) {
      return accountAt(route);
    }
    const create = creations[route];
    if (request.method === "POST" && create !== undefined) {
      return await create(await bodyOf(request));
    }
    return notFound();
  };

  /** How `state.failingFor` fails the request `call` names, if it does. */
  const failForNow = (call: string): Response | undefined => {
    const { failingFor } = state;
    if (
      failingFor === undefined ||
      failingFor.times <= 0 ||
      !call.startsWith(failingFor.prefix)
    ) {
      return undefined;
    }
    failingFor.times -= 1;
    if (failingFor.broken !== true) {
      const status = failingFor.status ?? 503;
      const defaultCode = status === 403 ? 1001 : null;
      const code =
        failingFor.code === undefined ? defaultCode : failingFor.code;
      const slug = failingFor.slug === undefined ? "Refused" : failingFor.slug;
      // As Composio's envelope has it: its message may repeat what was
      // sent, so connect reads only the slug and the code.
      return Response.json(
        {
          error: {
            message: "The API key doesn't have permissions: sent ak_secret",
            status,
            ...(slug === null ? {} : { slug }),
            ...(code === null ? {} : { code }),
            request_id: "req_test",
          },
        },
        { status }
      );
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode('{"id":'));
          controller.error(new Error("The connection broke"));
        },
      }),
      { headers: { "content-type": "application/json" } }
    );
  };

  const answer = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = url.pathname.slice(new URL(composioApiBase).pathname.length);
    state.requests.push({
      method: request.method,
      path: `${route}${url.search}`,
      keyed: request.headers.get("x-api-key") === testComposioKey,
      followsRedirects: request.redirect === "follow",
    });
    if (route.startsWith("/mcp")) {
      state.legacyRequests.push(`${request.method} ${route}`);
      return notFound();
    }
    if (request.headers.get("x-api-key") !== testComposioKey) {
      return Response.json(
        { error: { message: "Invalid API key" } },
        { status: 401 }
      );
    }
    if (state.health === "huge") {
      return hugeAnswer(state.hugeSent);
    }
    const failure = failures[state.health]?.();
    if (failure !== undefined) {
      return failure;
    }
    if (
      state.failing !== undefined &&
      `${request.method} ${route}`.startsWith(state.failing)
    ) {
      return new Response("Service Unavailable", { status: 503 });
    }
    const failedFor = failForNow(`${request.method} ${route}`);
    if (failedFor !== undefined) {
      return failedFor;
    }
    const cursor = url.searchParams.get("cursor");
    if (request.method === "GET" && route === "/toolkits") {
      return page(
        [...toolkits.map(toolkitItem), ...extra],
        cursor,
        state.endless
      );
    }
    if (
      request.method === "GET" &&
      route === "/tools" &&
      state.toolsStatus !== undefined
    ) {
      return Response.json(
        { error: { message: "Invalid request" } },
        { status: state.toolsStatus }
      );
    }
    const listed = catalogAnswer(toolkits, request);
    if (listed !== undefined) {
      return listed;
    }
    return await manage(request, route, url.searchParams);
  };

  beforeEach(() => {
    // Each test asks Composio afresh, as a new isolate would.
    forgetComposioCatalog();
    forgetCatalogLogos();
    state.logoRequests = [];
    state.logos = new Map();
    state.requests = [];
    state.health = "up";
    state.hugeSent = { bytes: 0 };
    state.endless = false;
    state.toolsStatus = undefined;
    state.failing = undefined;
    state.failingFor = undefined;
    state.slugCase = "lower";
    state.beforeUpdate = undefined;
    state.updateGate = undefined;
    state.sessionGate = undefined;
    state.sessionUrlBase = sessionUrlBase;
    state.answeredConfig = undefined;
    state.legacyRequests = [];
    state.holds = {
      authConfigs: new Map(),
      accounts: new Map(),
      sessions: new Map(),
    };
    mcp.reset();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      if (request.url.startsWith(sessionUrlBase) && pathname.endsWith("/mcp")) {
        return await mcp.answer(request);
      }
      if (request.url.startsWith(legacyMcpBase)) {
        state.legacyRequests.push(`${request.method} ${pathname}`);
        throw new Error("A request to Composio's legacy MCP server");
      }
      if (request.url.startsWith(`https://${logoHost}/`)) {
        return logoAnswer(request);
      }
      if (!request.url.startsWith(`${composioApiBase}/`)) {
        throw new Error(`Unexpected outbound request to ${request.url}`);
      }
      return await answer(request);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    // Connect never asks Composio's legacy per-server MCP API anything.
    if (state.legacyRequests.length > 0) {
      throw new Error(
        `Legacy MCP requests: ${state.legacyRequests.join(", ")}`
      );
    }
  });

  return {
    state,
    /**
     * The admin finishing at the auth link `url`, as Composio would: the
     * account ends `status`, after `pendingReads` reads that still see it
     * completing, and Composio sends the browser to `callback`, the
     * callback it was given with its own `status` (`success`, or `failed`
     * for an account that failed, unless `says` says otherwise) and
     * `connected_account_id` appended. `state` is the flow's, from it.
     */
    authorize: (
      url: string,
      {
        status = "ACTIVE",
        pendingReads = 0,
        says = status === "FAILED" ? "failed" : "success",
      }: {
        status?: FakeAccount["status"];
        pendingReads?: number;
        says?: string;
      } = {}
    ): { state: string; callback: string; account: FakeAccount } => {
      const found = [...state.holds.accounts].find(
        ([, { redirectUrl }]) => redirectUrl === url
      );
      if (found === undefined) {
        throw new Error(`No account at ${url}`);
      }
      const [accountId, account] = found;
      account.status = status;
      account.pendingReads = pendingReads;
      const callback = new URL(account.callbackUrl);
      callback.searchParams.append("status", says);
      callback.searchParams.append("connected_account_id", accountId);
      return {
        state: callback.searchParams.get("state") ?? "",
        callback: callback.href,
        account,
      };
    },
  };
};

/**
 * Composio's MCP server at `url` with `tools`, for each test in the file,
 * as `fakeMcpServer`; Composio's catalog lists them as the tools of
 * `toolkit`, tagged read-only as each declares itself.
 */
export const fakeComposioServer = (
  url: string,
  tools: readonly FakeTool[],
  toolkit: string
) => {
  const { state, answer, reset } = mcpServerWith(tools);
  const toolkits: FakeToolkit[] = [
    {
      slug: toolkit,
      name: toolkit,
      tools: tools.map(({ name, inputs, readOnly }) => ({
        slug: name,
        inputs,
        ...(readOnly === true ? { tags: ["readOnlyHint"] } : {}),
      })),
    },
  ];
  beforeEach(() => {
    forgetComposioCatalog();
    reset();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url === url) {
        return await answer(request);
      }
      const listed = request.url.startsWith(`${composioApiBase}/`)
        ? catalogAnswer(toolkits, request)
        : undefined;
      if (listed === undefined) {
        throw new Error(`Unexpected outbound request to ${request.url}`);
      }
      return listed;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  return state;
};
