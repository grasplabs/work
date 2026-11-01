/**
 * A stand-in for the Cloudflare REST API: it answers at the real URLs, in
 * the API's envelope, and keeps what each account holds, so the admin's
 * client runs unchanged against it. Only the token it was made with gets
 * in, and only to the accounts it holds. A test can plan failures (the
 * Nth call answers 429 or 500) and read every call it got.
 *
 * It answers in place of `fetch` in the isolate the admin runs in, which
 * is also where its runs' steps run: the tests' isolate, for each test
 * (test/cloudflare-api-mock.ts), and the browser journeys' admin, for its
 * whole run (test/e2e-worker.ts). D1 queries run on real D1 databases, one
 * for each database the fake holds at once (`CLIENT_D1_<n>`,
 * vite.test.config.ts and vite.e2e.config.ts).
 */
import {
  adminAskPath,
  adminAskPurpose,
  adminAskRequestSchema,
} from "@grasp-os/shared/admin-ask";
import {
  adminKickoffPath,
  adminKickoffPurpose,
  adminKickoffRequestSchema,
} from "@grasp-os/shared/admin-kickoff";
import type { AdminKickoffView } from "@grasp-os/shared/admin-kickoff";
import {
  adminSnapshotPath,
  adminSnapshotPurpose,
  adminSnapshotRequestSchema,
} from "@grasp-os/shared/admin-snapshot";
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import {
  aiStatusReportPath,
  aiStatusReportPurpose,
  aiStatusReportRequestSchema,
} from "@grasp-os/shared/ai-status-report";
import type {
  AiStatusReport,
  PlatformSpendRow,
} from "@grasp-os/shared/ai-status-report";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { gatewayScriptOf } from "@grasp-os/shared/connect-gateway";
import { whenAborted } from "@grasp-os/shared/deadline";
import { toHex } from "@grasp-os/shared/encoding";
import {
  clientsNamespace,
  platformWorkerName,
  stages,
} from "@grasp-os/shared/names";
import {
  onboardingSummaryPath,
  onboardingSummaryPurpose,
  onboardingSummaryRequestSchema,
} from "@grasp-os/shared/onboarding-summary";
import type { OnboardingSummary } from "@grasp-os/shared/onboarding-summary";
import {
  platformUpdateNoticeSchema,
  platformUpdatePath,
  platformUpdatePurpose,
  platformUpdateSignatureHeader,
} from "@grasp-os/shared/platform-change";
import {
  connectVersionPath,
  connectVersionPurpose,
  provisionProbePath,
  provisionProbePurpose,
  provisionProbeRequestSchema,
} from "@grasp-os/shared/provision-probe";
import type { ProvisionProbe } from "@grasp-os/shared/provision-probe";
import { z } from "zod";

import {
  base,
  envelope,
  notFound,
  paged,
  refusal,
  text,
} from "./cloudflare-api-kit.ts";
import type {
  AccountState,
  ApiCall,
  CoreState,
  Json,
  Route,
  ScriptState,
  VersionState,
} from "./cloudflare-api-kit.ts";
import {
  dispatchRoutes,
  forgetDatabase,
  forgetDatabases,
  workerRoutes,
} from "./cloudflare-api-workers.ts";

/** A client's core where it runs: the account its scripts are in, and its own state. */
interface CoreHost {
  account: AccountState;
  core: CoreState;
}

/** A client resource's name in a path: `grasp-<deploymentId>-…`. */
const deploymentPath = /\/grasp-(?<deployment>[a-z0-9]{10})-/u;

/** The client deployment whose resource `url` names, if it names one. */
export const deploymentOfPath = (url: string): string | undefined =>
  deploymentPath.exec(url)?.groups?.deployment;

/** The R2 jurisdiction a call names, as the API reads its header. */
const jurisdictionOf = (call: ApiCall): string =>
  call.headers.get("cf-r2-jurisdiction") ?? "default";

/**
 * What a client's core answers a platform update notice with, as core
 * does (core's src/platform-updates.ts): 204 once the signature checks
 * out, with the key its live version's auth secret gives, and the notice
 * parses; 403 otherwise. An account can have its core answer otherwise,
 * as one from before the endpoint would (`noticeStatus`).
 */
const takeNotice = async (
  { core }: CoreHost,
  live: VersionState,
  request: Request
): Promise<Response> => {
  if (core.noticeStatus !== undefined) {
    return new Response(null, { status: core.noticeStatus });
  }
  const body = await request.text();
  const key = await hkdfHmacKey(
    live.secrets.get("BETTER_AUTH_SECRET") ?? "",
    platformUpdatePurpose,
    ["sign"]
  );
  const expected = toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
  const notice = platformUpdateNoticeSchema.safeParse(JSON.parse(body));
  if (
    request.headers.get(platformUpdateSignatureHeader) !== expected ||
    !notice.success
  ) {
    return new Response("Forbidden", { status: 403 });
  }
  core.notices.push(notice.data);
  return new Response(null, { status: 204 });
};

/** What core answers a path it has no route for: its frontend's page. */
const frontendPage = (): Response =>
  new Response("<!doctype html><title>Grasp</title>", {
    headers: { "content-type": "text/html" },
  });

/** The binding kinds core's probe asks, of core and of connect (core's src/provision-probe.ts). */
const probedKinds = new Set([
  "d1",
  "r2_bucket",
  "durable_object_namespace",
  "worker_loader",
  "service",
]);

const bindingsSchema = z.array(
  z
    .object({
      type: z.string(),
      name: z.string(),
      json: z.unknown().optional(),
      service: z.string().optional(),
    })
    .loose()
);

/** A few of each clock's tasks, as core's and connect's src/clock.ts name them. */
const clockTaskNames = {
  core: ["audit.drain", "workflows.schedules", "connect.clock"],
  connect: ["oauth.flows", "vault.tokens"],
};

/**
 * The connect script core's `CONNECT` binding reaches: the script it names
 * in the account's own Workers, or, bound to the connect gateway, the
 * script its props name in the clients' dispatch namespace, as the gateway
 * forwards to it (@grasp-os/shared/connect-gateway). A core with no
 * `CONNECT` binding reaches no connect.
 */
const connectOf = (
  account: AccountState,
  binding: z.infer<typeof bindingsSchema>[number] | undefined
): ScriptState | undefined => {
  // A stage's gateway forwards into its stage's clients' namespace.
  const stage = stages.find(
    (each) => binding?.service === platformWorkerName("connect-gateway", each)
  );
  if (stage === undefined) {
    return binding?.service === undefined
      ? undefined
      : account.scripts.get(binding.service);
  }
  const script = gatewayScriptOf(binding?.props);
  return script === undefined
    ? undefined
    : account.namespaces.get(clientsNamespace(stage))?.get(script);
};

/**
 * The version a core whose live version is `live` names for its connect:
 * the version all of its connect's traffic goes to (`connectOf`), unless
 * the account says otherwise (`connectAnswersFirst`, `connectAnswering`);
 * null with no connect.
 */
const connectAnswering = (
  { account, core }: CoreHost,
  live: VersionState
): string | null => {
  const [early, ...later] = core.connectAnswersFirst ?? [];
  if (early !== undefined) {
    core.connectAnswersFirst = later;
    return early;
  }
  if (core.connectAnswering !== undefined) {
    return core.connectAnswering;
  }
  const connect = connectOf(
    account,
    bindingsSchema
      .parse(live.metadata.bindings ?? [])
      .find(({ name }) => name === "CONNECT")
  );
  const [only] = connect?.deployments[0]?.versions ?? [];
  return only?.percentage === 100 ? only.version_id : null;
};

/**
 * What a client's core answers the admin's provisioning probe with, as
 * core does (core's src/provision-probe.ts), once the signature checks
 * out with the key its live version's auth secret gives and the request
 * parses: the version answering, the `CLIENT_ID` its live version runs
 * with, each of its private bindings answering, and both clocks armed,
 * unless the account says otherwise (`coreProbe`). Anything else, and
 * any request to a core from before the probe, gets its frontend's page.
 */
const answerProbe = async (
  { account, core }: CoreHost,
  live: VersionState,
  request: Request
): Promise<Response> => {
  const probe = core.coreProbe ?? {};
  if (probe === "absent") {
    return frontendPage();
  }
  const body = await request.text();
  const key = await hkdfHmacKey(
    live.secrets.get("BETTER_AUTH_SECRET") ?? "",
    provisionProbePurpose,
    ["sign"]
  );
  const expected = toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
  if (
    request.headers.get(platformUpdateSignatureHeader) !== expected ||
    !provisionProbeRequestSchema.safeParse(JSON.parse(body)).success
  ) {
    return frontendPage();
  }
  const bindings = bindingsSchema.parse(live.metadata.bindings ?? []);
  // Connect's own, as core asks connect for them: the script its CONNECT
  // binding names, at its latest version.
  const connectBindings = bindingsSchema.parse(
    connectOf(
      account,
      bindings.find(({ name }) => name === "CONNECT")
    )?.versions.at(-1)?.metadata.bindings ?? []
  );
  const clientId = bindings.find(({ name }) => name === "CLIENT_ID")?.json;
  const down = new Set(probe.down);
  const clock = (name: "core" | "connect") =>
    probe.clocksDown?.includes(name) === true
      ? null
      : { armed: true, tasks: clockTaskNames[name] };
  return Response.json({
    version: core.answeringVersion ?? live.id,
    ...(probe.noConnectVersion === true
      ? {}
      : { connectVersion: connectAnswering({ account, core }, live) }),
    clientId:
      probe.asClient ?? (typeof clientId === "string" ? clientId : null),
    bindings: Object.fromEntries(
      [
        ...bindings.map((binding) => ({ ...binding, answers: binding.name })),
        ...connectBindings.map((binding) => ({
          ...binding,
          answers: `connect.${binding.name}`,
        })),
      ]
        .filter(({ type }) => probedKinds.has(type))
        .map(({ answers }) => [answers, !down.has(answers)])
    ),
    clocks: { core: clock("core"), connect: clock("connect") },
  } satisfies ProvisionProbe);
};

/**
 * What a client's core answers the admin's signed request for its
 * connect's version with, as core does (core's src/provision-probe.ts):
 * the version its connect answers as (`connectAnswering`), or 503 when it
 * names none, once the signature checks out with the key its live
 * version's auth secret gives for this purpose and the request parses.
 * Anything else, the router's secret alone included, gets its frontend's
 * page, as any path core has no route for.
 */
const answerConnectVersion = async (
  { account, core }: CoreHost,
  live: VersionState,
  request: Request
): Promise<Response> => {
  const probe = core.coreProbe ?? {};
  if (probe === "absent" || probe.noConnectVersion === true) {
    return frontendPage();
  }
  const body = await request.text();
  const key = await hkdfHmacKey(
    live.secrets.get("BETTER_AUTH_SECRET") ?? "",
    connectVersionPurpose,
    ["sign"]
  );
  const expected = toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
  if (
    request.headers.get(platformUpdateSignatureHeader) !== expected ||
    !provisionProbeRequestSchema.safeParse(JSON.parse(body)).success
  ) {
    return frontendPage();
  }
  const version = connectAnswering({ account, core }, live);
  return version === null
    ? Response.json({ ok: false }, { status: 503 })
    : Response.json({ ok: true, version });
};

/** None begun: what a core answers that has no onboarding. */
const noOnboarding: OnboardingSummary = {
  stage: "none",
  day: null,
  days: null,
  known: 0,
  needs: 0,
};

/**
 * What a client's core answers the admin's onboarding summary request
 * with, as core does (core's src/onboarding/summary.ts): the account's
 * summary once the signature checks out, with the key its live version's
 * auth secret gives, and the request parses; 403 otherwise; 404 from a
 * core from before the summary.
 */
const answerSummary = async (
  { core }: CoreHost,
  live: VersionState,
  request: Request
): Promise<Response> => {
  if (core.onboarding === "absent") {
    return new Response("Not found", { status: 404 });
  }
  const body = await request.text();
  const key = await hkdfHmacKey(
    live.secrets.get("BETTER_AUTH_SECRET") ?? "",
    onboardingSummaryPurpose,
    ["sign"]
  );
  const expected = toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
  const asked = onboardingSummaryRequestSchema.safeParse(JSON.parse(body));
  if (
    request.headers.get(platformUpdateSignatureHeader) !== expected ||
    !asked.success
  ) {
    return new Response("Forbidden", { status: 403 });
  }
  return Response.json(core.onboarding ?? noOnboarding);
};

/** The UTC month `monthsBack` before this one, such as `2026-09`. */
export const monthBack = (monthsBack: number): string => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1)
  )
    .toISOString()
    .slice(0, 7);
};

/**
 * A core's AI status report: `providers`, and what Grasp's own features
 * cost on its keys this month and last (none unless given), or no spend
 * at all (`unreported`), as a core on a release before it was reported
 * answers.
 */
export const aiStatusOf = (
  providers: AiStatusReport["providers"] = [],
  spend:
    | { thisMonth?: PlatformSpendRow[]; lastMonth?: PlatformSpendRow[] }
    | "unreported" = {}
): AiStatusReport =>
  spend === "unreported"
    ? { providers }
    : {
        providers,
        platformSpend: {
          thisMonth: { period: monthBack(0), rows: spend.thisMonth ?? [] },
          lastMonth: { period: monthBack(1), rows: spend.lastMonth ?? [] },
        },
      };

/**
 * What a client's core answers the admin's AI status request with, as
 * core does (core's src/ai-status-report.ts): the account's report once
 * the signature checks out, with the key its live version's auth secret
 * gives, and the request parses; 403 otherwise.
 */
const answerAiStatus = async (
  { core }: CoreHost,
  live: VersionState,
  request: Request
): Promise<Response> => {
  if (core.aiRedirect === true) {
    // As fetch does: a request that follows redirects gets what the other
    // end answers, here a report that reads as working.
    return request.redirect === "manual"
      ? new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.test/ai" },
        })
      : Response.json(core.ai ?? aiStatusOf());
  }
  const body = await request.text();
  const key = await hkdfHmacKey(
    live.secrets.get("BETTER_AUTH_SECRET") ?? "",
    aiStatusReportPurpose,
    ["sign"]
  );
  const expected = toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
  const asked = aiStatusReportRequestSchema.safeParse(JSON.parse(body));
  if (
    request.headers.get(platformUpdateSignatureHeader) !== expected ||
    !asked.success
  ) {
    return new Response("Forbidden", { status: 403 });
  }
  return Response.json(core.ai ?? aiStatusOf());
};

/** Two hex characters at a time. */
const hexPair = /../gu;

/** A company with nothing begun: what a core answers that has no onboarding. */
export const emptyAdminSnapshot = (name: string): AdminSnapshot => ({
  now: new Date().toISOString(),
  company: {
    name,
    timeZone: "Europe/Amsterdam",
    signInDomains: [],
    signIn: [],
    admins: [],
  },
  contacts: null,
  roster: null,
  plan: null,
  agreements: null,
  agreed: false,
  paused: false,
  told: false,
  mapped: [],
  links: [],
  interviews: [],
  works: null,
  kickoff: null,
  gate: {
    open: false,
    closedSince: null,
    threshold: 80,
    known: 0,
    ready: false,
    over: false,
    openedAt: null,
  },
  contract: null,
  members: [],
  integrations: null,
  asked: [],
  usage: [],
});

/**
 * What a client's core answers the admin's snapshot request with,
 * as core does (core's src/admin-snapshot.ts): the account's snapshot
 * once the signature checks out, with the key its live version's auth
 * secret gives for the admin's purpose, and the request parses, keeping
 * whom it names as the reader; 401 for a request signed otherwise, 403
 * for one that doesn't parse; 404 from a core from before the snapshot.
 */
const answerAdmin = async (
  { core }: CoreHost,
  live: VersionState,
  request: Request
): Promise<Response> => {
  if (core.admin === "absent") {
    return new Response("Not found", { status: 404 });
  }
  await core.adminHeld?.();
  const body = await request.text();
  const key = await hkdfHmacKey(
    live.secrets.get("BETTER_AUTH_SECRET") ?? "",
    adminSnapshotPurpose,
    ["verify"]
  );
  const signature = request.headers.get(platformUpdateSignatureHeader) ?? "";
  const signed = await crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(signature.match(hexPair) ?? [], (pair) =>
      Number.parseInt(pair, 16)
    ),
    new TextEncoder().encode(body)
  );
  if (!signed) {
    return new Response("Unauthorized", { status: 401 });
  }
  const asked = adminSnapshotRequestSchema.safeParse(JSON.parse(body));
  if (!asked.success || core.admin === "ended") {
    return new Response("Forbidden", { status: 403 });
  }
  core.adminReaders.push(asked.data.staff.email);
  if (core.admin === "garbled") {
    return Response.json({ company: core.name });
  }
  return Response.json(core.admin ?? emptyAdminSnapshot(core.name));
};

/**
 * What Grasp's own core answers Ask Grasp's question with, as core does
 * (core's src/admin-ask.ts): the account's answer once the signature
 * checks out, with the key its live version's auth secret gives for Ask
 * Grasp's purpose, and the question parses, keeping it; 401 for a request
 * signed otherwise, 403 for one that doesn't parse.
 */
const answerAsk = async (
  { core }: CoreHost,
  live: VersionState,
  request: Request
): Promise<Response> => {
  const body = await request.text();
  const key = await hkdfHmacKey(
    live.secrets.get("BETTER_AUTH_SECRET") ?? "",
    adminAskPurpose,
    ["verify"]
  );
  const signature = request.headers.get(platformUpdateSignatureHeader) ?? "";
  const signed = await crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(signature.match(hexPair) ?? [], (pair) =>
      Number.parseInt(pair, 16)
    ),
    new TextEncoder().encode(body)
  );
  if (!signed) {
    return new Response("Unauthorized", { status: 401 });
  }
  const asked = adminAskRequestSchema.safeParse(JSON.parse(body));
  if (!asked.success) {
    return new Response("Forbidden", { status: 403 });
  }
  core.asked.push(asked.data);
  if (core.ask === "no_model") {
    return Response.json({ code: "admin_ask.no_model" }, { status: 503 });
  }
  return Response.json(core.ask ?? { text: "An answer.", truncated: false });
};

/** A kickoff with nothing brought in yet, as core answers it. */
export const emptyKickoff = (): AdminKickoffView => ({
  transcript: null,
  read: false,
  fields: [],
  teams: 0,
});

/**
 * What a client's core answers the admin's kickoff request with, as core
 * does (core's src/admin-kickoff.ts): the account's kickoff once the
 * signature checks out, with the key its live version's auth secret gives
 * for the kickoff's purpose, and the request parses, keeping it; 401 for
 * a request signed otherwise, 403 for one that doesn't parse or a company
 * that keeps Grasp's staff out.
 */
const answerKickoff = async (
  { core }: CoreHost,
  live: VersionState,
  request: Request
): Promise<Response> => {
  const body = await request.text();
  const key = await hkdfHmacKey(
    live.secrets.get("BETTER_AUTH_SECRET") ?? "",
    adminKickoffPurpose,
    ["verify"]
  );
  const signature = request.headers.get(platformUpdateSignatureHeader) ?? "";
  const signed = await crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(signature.match(hexPair) ?? [], (pair) =>
      Number.parseInt(pair, 16)
    ),
    new TextEncoder().encode(body)
  );
  if (!signed) {
    return new Response("Unauthorized", { status: 401 });
  }
  const asked = adminKickoffRequestSchema.safeParse(JSON.parse(body));
  if (!asked.success) {
    return new Response("Forbidden", { status: 403 });
  }
  core.kickoffAsks.push(asked.data);
  if (core.kickoff === "shut_out") {
    return Response.json({ code: "onboarding.staff_only" }, { status: 403 });
  }
  return Response.json(core.kickoff ?? emptyKickoff());
};

/** The admin's signed requests core answers alike: by path, a `POST` each. */
const signedPosts: ReadonlyMap<
  string,
  (host: CoreHost, live: VersionState, request: Request) => Promise<Response>
> = new Map([
  [platformUpdatePath, takeNotice],
  [onboardingSummaryPath, answerSummary],
  [provisionProbePath, answerProbe],
  [connectVersionPath, answerConnectVersion],
  [adminAskPath, answerAsk],
  [adminKickoffPath, answerKickoff],
  [aiStatusReportPath, answerAiStatus],
]);

/** What each account holds, at the paths the API serves it. */
const accountRoutes: Route[] = [
  {
    method: "GET",
    path: /^$/u,
    answer: ({ account }) => envelope({ id: account.id, name: account.name }),
  },
  {
    method: "GET",
    path: /^\/d1\/database$/u,
    // The API matches `name` as a substring.
    answer: ({ account, call }) => {
      const name = call.query.get("name") ?? "";
      return paged(
        account.d1.filter((database) => database.name.includes(name)),
        call.query
      );
    },
  },
  {
    method: "POST",
    path: /^\/d1\/database$/u,
    answer: ({ account, json }) => {
      const jurisdiction = account.d1Reports ?? text(json, "jurisdiction");
      const database = {
        uuid: crypto.randomUUID(),
        name: text(json, "name"),
        ...(jurisdiction === "" ? {} : { jurisdiction }),
      };
      account.d1.push(database);
      return envelope(database);
    },
  },
  {
    method: "GET",
    path: /^\/r2\/buckets\/(?<name>[^/]+)$/u,
    answer: ({ account, call, params }) => {
      const bucket = account.buckets.find(
        ({ name, jurisdiction }) =>
          name === params.name && jurisdiction === jurisdictionOf(call)
      );
      return bucket === undefined
        ? notFound()
        : envelope({
            name: bucket.name,
            jurisdiction: account.r2Reports ?? bucket.jurisdiction,
          });
    },
  },
  {
    method: "POST",
    path: /^\/r2\/buckets$/u,
    answer: ({ account, call, json }) => {
      const bucket = {
        name: text(json, "name"),
        jurisdiction: jurisdictionOf(call),
      };
      account.buckets.push(bucket);
      return envelope({
        ...bucket,
        jurisdiction: account.r2Reports ?? bucket.jurisdiction,
      });
    },
  },
  {
    method: "DELETE",
    path: /^\/d1\/database\/(?<uuid>[^/]+)$/u,
    answer: ({ account, params }) => {
      const index = account.d1.findIndex(({ uuid }) => uuid === params.uuid);
      if (index === -1) {
        return notFound();
      }
      account.d1.splice(index, 1);
      // Its real database is free for the next one the fake makes.
      forgetDatabase(params.uuid ?? "");
      return envelope(null);
    },
  },
  {
    method: "DELETE",
    path: /^\/r2\/buckets\/(?<name>[^/]+)$/u,
    answer: ({ account, call, params }) => {
      const index = account.buckets.findIndex(
        ({ name, jurisdiction }) =>
          name === params.name && jurisdiction === jurisdictionOf(call)
      );
      if (index === -1) {
        return notFound();
      }
      if (account.fullBuckets.has(params.name ?? "")) {
        return refusal(
          409,
          10_008,
          "The bucket you tried to delete is not empty"
        );
      }
      account.buckets.splice(index, 1);
      return envelope(null);
    },
  },
  {
    method: "PUT",
    path: /^\/r2\/buckets\/(?<name>[^/]+)\/lifecycle$/u,
    answer: ({ account, call, params, json }) => {
      const bucket = account.buckets.find(
        ({ name, jurisdiction }) =>
          name === params.name && jurisdiction === jurisdictionOf(call)
      );
      if (bucket === undefined) {
        return notFound();
      }
      account.lifecycles.set(bucket.name, json);
      return envelope(null);
    },
  },
];

/** An account's scripts, as the API lists them. */
const memberRoutes: Route[] = [
  {
    method: "GET",
    path: /^\/workers\/scripts$/u,
    answer: ({ account }) =>
      envelope([...account.scripts.keys()].map((id) => ({ id }))),
  },
];

const routes = [
  ...accountRoutes,
  ...memberRoutes,
  ...workerRoutes,
  ...dispatchRoutes,
];

/** Whether `caller` is an accepted member of `account`. */
const isMember = (account: AccountState, caller: string | undefined) =>
  caller !== undefined && account.members.get(caller) === "accepted";

/** Who the deployer's token belongs to. */
export const deployerEmail = "deployer@grasp.test";

/** The route that serves `call`, with its path's named parts. */
const routeOf = (
  call: ApiCall,
  rest: string
): { route: Route; params: Record<string, string> } | null => {
  for (const route of routes) {
    const match = route.method === call.method ? route.path.exec(rest) : null;
    if (match !== null) {
      return { route, params: { ...match.groups } };
    }
  }
  return null;
};

/**
 * How a planned call fails: timed out at the edge (408), rate-limited
 * (429, optionally with a `Retry-After`), a server error in the envelope (500, 503), the edge's
 * HTML error page (502), no answer before it ran (`network`), or no answer
 * after it ran (`lost`: the change is made, its response never arrives),
 * or, for a D1 query, an answer that succeeds with a statement that didn't
 * (`statement-failed`).
 */
export type Failure =
  /** A refusal: the admin retries none. */
  | 400
  /**
   * A 400 with no answer Cloudflare wrote, as a proxy in front of it may
   * send: no error code to read.
   */
  | "400-uncoded"
  | 408
  | 429
  | 500
  | 502
  | 503
  | "network"
  | "lost"
  | "statement-failed"
  | { retryAfter: string };

const lostConnection = (): never => {
  throw new TypeError("Network connection lost.");
};

const failed = (failure: Exclude<Failure, "lost">): Response => {
  if (failure === "network") {
    return lostConnection();
  }
  if (failure === "statement-failed") {
    return envelope([
      { results: [], success: true, meta: {} },
      { results: [], success: false, meta: {} },
    ]);
  }
  if (typeof failure === "object") {
    const response = refusal(
      429,
      971,
      "Please wait and consider throttling your request speed"
    );
    response.headers.set("retry-after", failure.retryAfter);
    return response;
  }
  if (failure === 400) {
    return refusal(400, 10_000, "Bad request");
  }
  if (failure === "400-uncoded") {
    return new Response("<html>Bad request</html>", {
      status: 400,
      headers: { "content-type": "text/html" },
    });
  }
  if (failure === 408) {
    return refusal(408, 10_000, "Request timeout");
  }
  if (failure === 502) {
    return new Response("<html>Bad gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });
  }
  return failure === 429
    ? refusal(
        429,
        971,
        "Please wait and consider throttling your request speed"
      )
    : refusal(failure, 10_000, "Internal error");
};

/** Email Sending's domains in a zone. */

const accountRoute = /^\/accounts\/(?<id>[^/]+)(?<rest>\/.*)?$/u;

/** A call's body: JSON parsed, form data as such, anything else as text. */
const readBody = async (request: Request): Promise<unknown> => {
  const type = request.headers.get("content-type") ?? "";
  if (type.startsWith("application/json")) {
    return await request.json();
  }
  if (type.startsWith("multipart/form-data")) {
    return await request.formData();
  }
  return request.body === null ? undefined : await request.text();
};

/**
 * A fake Cloudflare API that lets `token` (the deployer's) in, to the
 * accounts its user is an accepted member of. It answers what it's
 * sent in place of `fetch` (`fetch`), until it's emptied (`reset`). Add
 * accounts with `addAccount`; plan failures with `failCall`.
 */
export const fakeCloudflareApi = (token: string) => {
  const accounts = new Map<string, AccountState>();
  const calls: ApiCall[] = [];
  const planned = new Map<number, Failure>();
  /** Failures planned for the next call a test picks out, each once. */
  const matched: { matches: (call: ApiCall) => boolean; failure: Failure }[] =
    [];
  /**
   * What runs before the fake answers the next call a test picks out, each
   * once: something else landing while that call is in flight.
   */
  const interleaved: {
    matches: (call: ApiCall) => boolean;
    meanwhile: () => Promise<void>;
  }[] = [];
  /**
   * What runs once the fake has answered the next call a test picks out,
   * before its caller gets the answer, each once: the caller held between
   * what it read and what it does next.
   */
  const answeredThen: {
    matches: (call: ApiCall) => boolean;
    meanwhile: () => Promise<void>;
  }[] = [];

  /**
   * Adds an account `member` is a member of, and returns what it holds; the
   * one there already when one has `id`.
   */
  const addAccount = (
    name = "Client",
    member = deployerEmail,
    /** Its id, for an account the admin knows by its own, such as Grasp's. */
    id = crypto.randomUUID().replaceAll("-", "")
  ): AccountState => {
    const known = accounts.get(id);
    if (known !== undefined) {
      return known;
    }
    const account: AccountState = {
      id,
      name,
      members: new Map([[member, "accepted"]]),
      d1: [],
      buckets: [],
      fullBuckets: new Set(),
      lifecycles: new Map(),
      scripts: new Map(),
      namespaces: new Map(),
      assets: new Set(),
      sessions: new Map(),
      completions: new Set(),
      scriptUploads: [],
    };
    accounts.set(account.id, account);
    return account;
  };

  /** Each client's core, by client id (`coreOf`). */
  const cores = new Map<string, CoreState>();
  /** Every request a client's core got in this test, by client. */
  const coreRequests: { clientId: string; url: string }[] = [];
  /**
   * Requests cores are answering now, by client; the most clients with one
   * at once; and how many a caller gave up on while their core held them.
   */
  const coreLoad = { now: new Map<string, number>(), peak: 0, aborted: 0 };

  /**
   * Client `clientId`'s core, as the fake answers for it wherever its
   * scripts run: a healthy one that has taken nothing yet, until a test
   * says otherwise.
   */
  const coreOf = (clientId: string): CoreState => {
    const known = cores.get(clientId);
    if (known !== undefined) {
      return known;
    }
    const core: CoreState = {
      name: clientId,
      notices: [],
      adminReaders: [],
      asked: [],
      kickoffAsks: [],
    };
    cores.set(clientId, core);
    return core;
  };

  /** The client a version runs as: the `CLIENT_ID` its bindings give. */
  const clientOf = (live: VersionState): string => {
    const clientId = bindingsSchema
      .parse(live.metadata.bindings ?? [])
      .find(({ name }) => name === "CLIENT_ID")?.json;
    return typeof clientId === "string" ? clientId : "";
  };

  /**
   * Calls being answered now, and the most at once; and the most accounts
   * with a call being answered at once.
   */
  const load = { now: 0, peak: 0, peakAccounts: 0 };
  /** Calls being answered now, by account. */
  const busyAccounts = new Map<string, number>();
  /** Calls being answered now, by the client deployment their path names. */
  const busyClients = new Map<string, number>();
  /** The most clients with a call being answered at once. */
  const clientLoad = { peak: 0 };
  /** Calls whose caller aborted them before they were answered. */
  const aborted = { count: 0 };
  /** Admin snapshot requests to cores under way, and the most at once in this test. */
  const adminReads = { now: 0, peak: 0 };
  /** The requests a redirect sent elsewhere, with the router secret they carried. */
  const redirected: { url: string; routerSecret: string | null }[] = [];
  const dispatched: { namespace: string; script: string; url: string }[] = [];

  /** Whose token a call carries: the deployer's. */
  const callers = new Map([[`Bearer ${token}`, deployerEmail]]);
  /**
   * Answers a call that names no account (`/user`, `/accounts`), or
   * undefined for any other.
   */
  const answerUnscoped = (
    call: ApiCall,
    caller: string | undefined
  ): Response | undefined => {
    if (call.path !== "/user" && call.path !== "/accounts") {
      return undefined;
    }
    if (caller === undefined) {
      return refusal(403, 10_000, "Authentication error");
    }
    if (call.path === "/user") {
      return envelope({ email: caller });
    }
    if (call.method !== "GET") {
      return undefined;
    }
    // The API matches `name` loosely; the fake as a substring.
    const name = call.query.get("name") ?? "";
    return paged(
      [...accounts.values()]
        .filter(
          (account) => isMember(account, caller) && account.name.includes(name)
        )
        .map(({ id, name: accountName }) => ({ id, name: accountName })),
      call.query
    );
  };

  /** Answers `call` as the API would. */
  const respond = async (
    request: Request,
    call: ApiCall
  ): Promise<Response> => {
    const caller = callers.get(request.headers.get("authorization") ?? "");
    const unscoped = answerUnscoped(call, caller);
    if (unscoped !== undefined) {
      return unscoped;
    }
    const match = accountRoute.exec(call.path)?.groups;
    const found = routeOf(call, match?.rest ?? "");
    const session = found?.route.session === true;
    // An upload session's token opens its upload, and nothing else; the
    // account's token doesn't open the upload.
    if (session ? caller !== undefined : caller === undefined) {
      return refusal(403, 10_000, "Authentication error");
    }
    const account = accounts.get(match?.id ?? "");
    if (account === undefined || (!session && !isMember(account, caller))) {
      return refusal(403, 9109, "Unauthorized to access requested resource");
    }
    if (found === null) {
      // As the API answers a path it doesn't serve.
      return refusal(400, 7003, "No route for the URI");
    }
    const json: Json =
      typeof call.body === "object" && call.body !== null
        ? { ...call.body }
        : {};
    return await found.route.answer({
      account,
      call,
      params: found.params,
      json,
    });
  };

  const answer = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const call: ApiCall = {
      method: request.method,
      path: url.pathname.slice(new URL(base).pathname.length),
      query: url.searchParams,
      headers: request.headers,
      body: await readBody(request),
    };
    calls.push(call);
    const match = matched.findIndex(({ matches }) => matches(call));
    const [picked] = match === -1 ? [] : matched.splice(match, 1);
    const failure = planned.get(calls.length) ?? picked?.failure;
    let response: Response;
    if (failure === "lost") {
      await respond(request, call);
      response = lostConnection();
    } else if (failure === undefined) {
      const between = interleaved.findIndex(({ matches }) => matches(call));
      const [meanwhile] = between === -1 ? [] : interleaved.splice(between, 1);
      await meanwhile?.meanwhile();
      response = await respond(request, call);
    } else {
      response = failed(failure);
    }
    // Answered, a failure too: the caller holds what it got back.
    const after = answeredThen.findIndex(({ matches }) => matches(call));
    const [then] = after === -1 ? [] : answeredThen.splice(after, 1);
    await then?.meanwhile();
    return response;
  };

  /**
   * What a client's core answers, once it got to it (`workerAnswer`): its
   * live version's `/health`, to a request carrying the router secret that
   * version has, the platform update notices it takes, and the admin's
   * signed requests it answers, its provisioning probe among them. One
   * whose core redirects answers a request that won't follow with the
   * redirect, and one that does as wherever it points would, as its core.
   */
  const coreAnswer = async (
    request: Request,
    url: URL,
    { account, live }: { account: AccountState; live: VersionState }
  ): Promise<Response> => {
    const core = coreOf(clientOf(live));
    if (core.redirectsTo !== undefined) {
      if (request.redirect === "manual") {
        // Its body unread: a redirect that's followed sends it on.
        return new Response(null, {
          status: 307,
          headers: { location: new URL(url.pathname, core.redirectsTo).href },
        });
      }
      redirected.push({
        url: new URL(url.pathname, core.redirectsTo).href,
        routerSecret: request.headers.get("x-grasp-router-secret"),
      });
    }
    if (core.unhealthy !== undefined && core.unhealthy > 0) {
      core.unhealthy -= 1;
      return new Response("Starting", { status: 503 });
    }
    const secret = live.secrets.get("ROUTER_SECRET");
    if (
      secret === undefined ||
      request.headers.get("x-grasp-router-secret") !== secret
    ) {
      return new Response("Forbidden", { status: 403 });
    }
    const signed =
      request.method === "POST" ? signedPosts.get(url.pathname) : undefined;
    if (signed !== undefined) {
      return await signed({ account, core }, live, request);
    }
    if (url.pathname === adminSnapshotPath && request.method === "POST") {
      adminReads.now += 1;
      adminReads.peak = Math.max(adminReads.peak, adminReads.now);
      try {
        // As fetch does: an aborted request ends at once, whatever its
        // core was still doing.
        return await Promise.race([
          answerAdmin({ account, core }, live, request),
          whenAborted(request.signal),
        ]);
      } finally {
        adminReads.now -= 1;
      }
    }
    if (url.pathname !== "/health") {
      return new Response("Not found", { status: 404 });
    }
    const [early, ...later] = core.healthAnswersFirst ?? [];
    core.healthAnswersFirst = later;
    return Response.json({
      ok: true,
      version: early ?? core.answeringVersion ?? live.id,
    });
  };

  /**
   * What a client's core answers a request with, wherever it comes from
   * (the namespace, or its hostname through the router), each request on
   * record, after whatever its core holds it for (`held`).
   */
  const workerAnswer = async (
    request: Request,
    url: URL,
    worker: { account: AccountState; live: VersionState }
  ): Promise<Response> => {
    const clientId = clientOf(worker.live);
    coreRequests.push({ clientId, url: request.url });
    coreLoad.now.set(clientId, (coreLoad.now.get(clientId) ?? 0) + 1);
    coreLoad.peak = Math.max(coreLoad.peak, coreLoad.now.size);
    try {
      const { held } = coreOf(clientId);
      if (held !== undefined) {
        try {
          await Promise.race([held(), whenAborted(request.signal)]);
        } catch (error) {
          coreLoad.aborted += 1;
          throw error;
        }
      }
      return await coreAnswer(request, url, worker);
    } finally {
      const left = (coreLoad.now.get(clientId) ?? 1) - 1;
      if (left === 0) {
        coreLoad.now.delete(clientId);
      } else {
        coreLoad.now.set(clientId, left);
      }
    }
  };

  /**
   * The dispatch namespace `name` in account `accountId`, as a Worker
   * binding reaches it: only that account's namespace, as a real
   * DISPATCHER binds one namespace in its own account. Each script's live
   * version answers as its client's core (`workerAnswer`); a
   * script it doesn't have, or one only another account holds, throws, as
   * Workers for Platforms does.
   */
  const dispatcher = (accountId: string, name: string) => ({
    get: (scriptName: string) => {
      const account = accounts.get(accountId);
      const script = account?.namespaces.get(name)?.get(scriptName);
      const [only] = script?.deployments[0]?.versions ?? [];
      const live = script?.versions.find(({ id }) => id === only?.version_id);
      const worker =
        account === undefined || live === undefined
          ? undefined
          : { account, live };
      if (worker === undefined) {
        throw new Error(`Worker not found: ${scriptName}`);
      }
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          dispatched.push({
            namespace: name,
            script: scriptName,
            url: request.url,
          });
          return await workerAnswer(request, new URL(request.url), worker);
        },
      };
    },
  });

  /**
   * The live core a client's hostname reaches, as the router routes it:
   * the core script in a namespace whose live version runs as the client
   * the hostname's first label names; undefined for any other host.
   */
  const routedCore = (
    url: URL
  ): { account: AccountState; live: VersionState } | undefined => {
    const [clientId] = url.hostname.split(".");
    const routed = [...accounts.values()].flatMap((account) =>
      [...account.namespaces.values()].flatMap((scripts) =>
        [...scripts]
          .filter(([name]) => name.endsWith("-core"))
          .flatMap(([, script]) => {
            const [only] = script.deployments[0]?.versions ?? [];
            const live = script.versions.find(
              ({ id }) => id === only?.version_id
            );
            return live === undefined || clientOf(live) !== clientId
              ? []
              : [{ account, live }];
          })
      )
    );
    return routed[0];
  };

  /** What the API, or a client's hostname through the router, answers `fetch(input, init)` with. */
  const answerFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const request = new Request(input, init);
    if (!request.url.startsWith(`${base}/`)) {
      const url = new URL(request.url);
      const core = routedCore(url);
      if (core === undefined) {
        throw new Error(`Unexpected outbound request to ${request.url}`);
      }
      return await workerAnswer(request, url, core);
    }
    load.now += 1;
    load.peak = Math.max(load.peak, load.now);
    const accountId = accountRoute.exec(
      new URL(request.url).pathname.slice(new URL(base).pathname.length)
    )?.groups?.id;
    if (accountId !== undefined) {
      busyAccounts.set(accountId, (busyAccounts.get(accountId) ?? 0) + 1);
      load.peakAccounts = Math.max(load.peakAccounts, busyAccounts.size);
    }
    const deployment = deploymentOfPath(request.url);
    if (deployment !== undefined) {
      busyClients.set(deployment, (busyClients.get(deployment) ?? 0) + 1);
      clientLoad.peak = Math.max(clientLoad.peak, busyClients.size);
    }
    try {
      // As fetch does: a request whose signal aborts before it's answered
      // rejects at once, whatever the fake was doing with it.
      let answered = false;
      return await Promise.race([
        (async () => {
          const response = await answer(request);
          answered = true;
          return response;
        })(),
        (async () => {
          try {
            return await whenAborted(request.signal);
          } catch (error) {
            if (!answered) {
              aborted.count += 1;
            }
            throw error;
          }
        })(),
      ]);
    } finally {
      load.now -= 1;
      if (deployment !== undefined) {
        const left = (busyClients.get(deployment) ?? 1) - 1;
        if (left === 0) {
          busyClients.delete(deployment);
        } else {
          busyClients.set(deployment, left);
        }
      }
      if (accountId !== undefined) {
        const left = (busyAccounts.get(accountId) ?? 1) - 1;
        if (left === 0) {
          busyAccounts.delete(accountId);
        } else {
          busyAccounts.set(accountId, left);
        }
      }
    }
  };

  /** Empties the fake: no accounts, calls or plans left. */
  const reset = (): void => {
    accounts.clear();
    cores.clear();
    coreRequests.length = 0;
    coreLoad.now.clear();
    coreLoad.peak = 0;
    coreLoad.aborted = 0;
    forgetDatabases();
    calls.length = 0;
    planned.clear();
    matched.length = 0;
    interleaved.length = 0;
    answeredThen.length = 0;
    load.peak = 0;
    load.peakAccounts = 0;
    busyAccounts.clear();
    clientLoad.peak = 0;
    busyClients.clear();
    aborted.count = 0;
    adminReads.now = 0;
    adminReads.peak = 0;
    redirected.length = 0;
    dispatched.length = 0;
  };

  return {
    /** Answers in place of `fetch`. */
    fetch: answerFetch,
    /** The dispatch namespace `name`, as the router and the admin bind it. */
    dispatcher,
    /** Every request a namespace's script got through `dispatcher`, in this test. */
    dispatched: (): readonly {
      namespace: string;
      script: string;
      url: string;
    }[] => dispatched,
    /** Empties the fake. */
    reset,
    /** Every call the fake got in this test, in order. */
    calls,
    /** The most calls it was answering at once in this test. */
    peakConcurrency: () => load.peak,
    /** The most accounts it was answering calls for at once in this test. */
    peakAccounts: () => load.peakAccounts,
    /** The most clients it was answering calls about their resources for at once in this test. */
    peakClients: () => clientLoad.peak,
    /** The most admin snapshot requests cores were answering at once in this test. */
    peakAdminReads: () => adminReads.peak,
    /** The requests a core's redirect sent elsewhere, in this test. */
    redirected: (): readonly { url: string; routerSecret: string | null }[] =>
      redirected,
    /** How many calls their caller aborted before they were answered, in this test. */
    abortedCalls: () => aborted.count,
    /** Adds an account the token is a member of, and returns what it holds. */
    addAccount,
    /** Client `clientId`'s core, as the fake answers for it: a test sets how. */
    coreOf,
    /** Every request a client's core got in this test, in order. */
    coreRequests: (): readonly { clientId: string; url: string }[] =>
      coreRequests,
    /** The most clients whose cores were answering a request at once in this test. */
    peakCores: () => coreLoad.peak,
    /** How many requests a caller gave up on while their core held them, in this test. */
    abortedCoreRequests: () => coreLoad.aborted,
    /** Fails the `n`th call from now as `failure` says, whatever it asks. */
    failCall: (n: number, failure: Failure) => {
      planned.set(calls.length + n, failure);
    },
    /** Fails the next call `matches` picks out as `failure` says, once. */
    failNext: (matches: (call: ApiCall) => boolean, failure: Failure) => {
      matched.push({ matches, failure });
    },
    /**
     * Runs `meanwhile` once the next call `matches` picks out has arrived
     * and before it's answered, once: so what `meanwhile` does lands
     * first, whatever the call then does.
     */
    beforeAnswering: (
      matches: (call: ApiCall) => boolean,
      meanwhile: () => Promise<void>
    ) => {
      interleaved.push({ matches, meanwhile });
    },
    /**
     * Runs `meanwhile` once the next call `matches` picks out has been
     * answered and before its caller gets the answer, once: so what
     * `meanwhile` does lands after the caller's read, and before it acts
     * on it.
     */
    afterAnswering: (
      matches: (call: ApiCall) => boolean,
      meanwhile: () => Promise<void>
    ) => {
      answeredThen.push({ matches, meanwhile });
    },
  };
};
