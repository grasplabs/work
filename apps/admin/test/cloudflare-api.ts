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
import {
  quotaLimitsHash,
  quotaLimitsSchema,
} from "@grasp-os/shared/quota-policy";
import {
  quotaPolicyReportPath,
  quotaPolicyReportPurpose,
  quotaPolicyReportRequestSchema,
} from "@grasp-os/shared/quota-policy-report";
import type { QuotaPolicyReport } from "@grasp-os/shared/quota-policy-report";
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
  Json,
  Route,
  ScriptState,
  VersionState,
} from "./cloudflare-api-kit.ts";
import {
  dispatchRoutes,
  forgetDatabases,
  workerRoutes,
} from "./cloudflare-api-workers.ts";

/** The R2 jurisdiction a call names, as the API reads its header. */
const jurisdictionOf = (call: ApiCall): string =>
  call.headers.get("cf-r2-jurisdiction") ?? "default";

const subdomainOf = (account: AccountState): Response =>
  account.subdomain === undefined
    ? notFound()
    : envelope({ subdomain: account.subdomain });

/**
 * What a client's core answers a platform update notice with, as core
 * does (core's src/platform-updates.ts): 204 once the signature checks
 * out, with the key its live version's auth secret gives, and the notice
 * parses; 403 otherwise. An account can have its core answer otherwise,
 * as one from before the endpoint would (`noticeStatus`).
 */
const takeNotice = async (
  account: AccountState,
  live: VersionState,
  request: Request
): Promise<Response> => {
  if (account.noticeStatus !== undefined) {
    return new Response(null, { status: account.noticeStatus });
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
  account.notices.push(notice.data);
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
  account: AccountState,
  live: VersionState
): string | null => {
  const [early, ...later] = account.connectAnswersFirst ?? [];
  if (early !== undefined) {
    account.connectAnswersFirst = later;
    return early;
  }
  if (account.connectAnswering !== undefined) {
    return account.connectAnswering;
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
  account: AccountState,
  live: VersionState,
  request: Request
): Promise<Response> => {
  const probe = account.coreProbe ?? {};
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
    version: account.answeringVersion ?? live.id,
    ...(probe.noConnectVersion === true
      ? {}
      : { connectVersion: connectAnswering(account, live) }),
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
  account: AccountState,
  live: VersionState,
  request: Request
): Promise<Response> => {
  const probe = account.coreProbe ?? {};
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
  const version = connectAnswering(account, live);
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
  account: AccountState,
  live: VersionState,
  request: Request
): Promise<Response> => {
  if (account.onboarding === "absent") {
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
  return Response.json(account.onboarding ?? noOnboarding);
};

/** The `QUOTA_LIMITS` a version was deployed with, if one core takes. */
const quotaLimitsOf = (version: VersionState) => {
  const bindings = z
    .array(
      z
        .object({
          type: z.string(),
          name: z.string(),
          json: z.unknown().optional(),
        })
        .loose()
    )
    .safeParse(version.metadata.bindings);
  const binding = bindings.success
    ? bindings.data.find(
        ({ type, name }) => type === "json" && name === "QUOTA_LIMITS"
      )
    : undefined;
  const parsed = quotaLimitsSchema.safeParse(binding?.json);
  return parsed.success ? parsed.data : undefined;
};

/**
 * What a client's core answers the console's quota policy report request
 * with, as core does (core's src/workflows/quota-report.ts): the policy it
 * applies, the highest generation any of its versions was deployed with,
 * since core records each and refuses a lower one; the platform's own
 * (generation 0) when none set one. 403 unless the signature, with the key
 * its live version's auth secret gives, checks out and the request parses;
 * 404 from a core from before the report.
 */
const answerQuotaPolicy = async (
  account: AccountState,
  script: ScriptState,
  live: VersionState,
  request: Request
): Promise<Response> => {
  if (account.quotaPolicy === "absent") {
    return new Response("Not found", { status: 404 });
  }
  if (account.quotaPolicy === "redirect") {
    // As fetch does: a request that follows redirects gets what the other
    // end answers, here a policy that matches anything none is set for.
    return request.redirect === "manual"
      ? new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.test/quota" },
        })
      : Response.json({
          generation: 0,
          lowered: {},
          limitsHash: null,
          recordedAt: null,
        } satisfies QuotaPolicyReport);
  }
  const body = await request.text();
  const key = await hkdfHmacKey(
    live.secrets.get("BETTER_AUTH_SECRET") ?? "",
    quotaPolicyReportPurpose,
    ["sign"]
  );
  const expected = toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
  const asked = quotaPolicyReportRequestSchema.safeParse(JSON.parse(body));
  if (
    request.headers.get(platformUpdateSignatureHeader) !== expected ||
    !asked.success
  ) {
    return new Response("Forbidden", { status: 403 });
  }
  // Only the versions that went live: core records a generation as it
  // runs under it, never one uploaded and left without traffic. Each
  // generation keeps the limits it first went live with, as core records
  // them; a later version under it with other limits changes nothing.
  const ranLive = new Set(
    script.deployments.flatMap(({ versions }) =>
      versions.map(({ version_id: id }) => id)
    )
  );
  let highest: QuotaPolicyReport = {
    generation: 0,
    lowered: {},
    limitsHash: null,
    recordedAt: null,
  };
  for (const version of script.versions.filter(({ id }) => ranLive.has(id))) {
    const limits = quotaLimitsOf(version);
    if (limits !== undefined && limits.generation > highest.generation) {
      highest = {
        generation: limits.generation,
        lowered: limits.limits,
        // oxlint-disable-next-line no-await-in-loop -- versions in order
        limitsHash: await quotaLimitsHash(limits.limits),
        recordedAt: new Date().toISOString(),
      };
    }
  }
  return Response.json(highest);
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
  account: AccountState,
  live: VersionState,
  request: Request
): Promise<Response> => {
  if (account.admin === "absent") {
    return new Response("Not found", { status: 404 });
  }
  await account.adminHeld?.();
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
  if (!asked.success || account.admin === "ended") {
    return new Response("Forbidden", { status: 403 });
  }
  account.adminReaders.push(asked.data.staff.email);
  if (account.admin === "garbled") {
    return Response.json({ company: account.name });
  }
  return Response.json(account.admin ?? emptyAdminSnapshot(account.name));
};

/**
 * What Grasp's own core answers Ask Grasp's question with, as core does
 * (core's src/admin-ask.ts): the account's answer once the signature
 * checks out, with the key its live version's auth secret gives for Ask
 * Grasp's purpose, and the question parses, keeping it; 401 for a request
 * signed otherwise, 403 for one that doesn't parse.
 */
const answerAsk = async (
  account: AccountState,
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
  account.asked.push(asked.data);
  if (account.ask === "no_model") {
    return Response.json({ code: "admin_ask.no_model" }, { status: 503 });
  }
  return Response.json(account.ask ?? { text: "An answer.", truncated: false });
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
  account: AccountState,
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
  account.kickoffAsks.push(asked.data);
  if (account.kickoff === "shut_out") {
    return Response.json({ code: "onboarding.staff_only" }, { status: 403 });
  }
  return Response.json(account.kickoff ?? emptyKickoff());
};

/** The admin's signed requests core answers alike: by path, a `POST` each. */
const signedPosts: ReadonlyMap<
  string,
  (
    account: AccountState,
    live: VersionState,
    request: Request
  ) => Promise<Response>
> = new Map([
  [platformUpdatePath, takeNotice],
  [onboardingSummaryPath, answerSummary],
  [provisionProbePath, answerProbe],
  [connectVersionPath, answerConnectVersion],
  [adminAskPath, answerAsk],
  [adminKickoffPath, answerKickoff],
]);

/**
 * The workers.dev subdomains taken across Cloudflare: a subdomain is one
 * account's only.
 */
const takenSubdomains = new Set<string>();

/** What each account holds, at the paths the API serves it. */
const accountRoutes: Route[] = [
  {
    method: "GET",
    path: /^$/u,
    answer: ({ account }) => envelope({ id: account.id, name: account.name }),
  },
  {
    method: "GET",
    path: /^\/workers\/subdomain$/u,
    answer: ({ account }) => subdomainOf(account),
  },
  {
    method: "PUT",
    path: /^\/workers\/subdomain$/u,
    answer: ({ account, json }) => {
      const wanted = text(json, "subdomain");
      if (takenSubdomains.has(wanted) && account.subdomain !== wanted) {
        return refusal(400, 10_031, "Subdomain is unavailable");
      }
      takenSubdomains.add(wanted);
      account.subdomain = wanted;
      return subdomainOf(account);
    },
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
  {
    method: "GET",
    path: /^\/ai-gateway\/gateways\/(?<id>[^/]+)$/u,
    answer: ({ account, params }) => {
      const gateway = account.gateways.find(({ id }) => id === params.id);
      return gateway === undefined ? notFound() : envelope(gateway);
    },
  },
  {
    method: "POST",
    path: /^\/ai-gateway\/gateways$/u,
    answer: ({ account, json }) => {
      const gateway = { authentication: false, ...json };
      account.gateways.push(gateway);
      return envelope(gateway);
    },
  },
  {
    method: "PUT",
    path: /^\/ai-gateway\/gateways\/(?<id>[^/]+)$/u,
    answer: ({ account, params, json }) => {
      const index = account.gateways.findIndex(({ id }) => id === params.id);
      if (index === -1) {
        return notFound();
      }
      // An update replaces the gateway's settings, as the API does.
      const gateway = { id: params.id, authentication: false, ...json };
      account.gateways[index] = gateway;
      return envelope(gateway);
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
const sendingRoute = /^\/zones\/(?<zone>[^/]+)\/email\/sending\/subdomains$/u;

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

  /** Adds an account `member` is a member of, and returns what it holds. */
  const addAccount = (
    name = "Client",
    member = deployerEmail
  ): AccountState => {
    const account: AccountState = {
      id: crypto.randomUUID().replaceAll("-", ""),
      name,
      members: new Map([[member, "accepted"]]),
      d1: [],
      buckets: [],
      fullBuckets: new Set(),
      lifecycles: new Map(),
      gateways: [],
      zones: [],
      scripts: new Map(),
      namespaces: new Map(),
      workflows: new Map(),
      assets: new Set(),
      sessions: new Map(),
      completions: new Set(),
      scriptUploads: [],
      notices: [],
      adminReaders: [],
      asked: [],
      kickoffAsks: [],
    };
    accounts.set(account.id, account);
    return account;
  };

  /**
   * Calls being answered now, and the most at once; and the most accounts
   * with a call being answered at once.
   */
  const load = { now: 0, peak: 0, peakAccounts: 0 };
  /** Calls being answered now, by account. */
  const busyAccounts = new Map<string, number>();
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

  /**
   * Answers a call about zones (`/zones`, and Email Sending's domains in
   * one), as the API does for zones in the accounts `caller` is a member
   * of; undefined for any other call. A new zone is pending, as one whose
   * name servers aren't delegated yet; a zone's name is Cloudflare's only.
   */
  const answerZones = (
    call: ApiCall,
    caller: string | undefined
  ): Response | undefined => {
    const sending = sendingRoute.exec(call.path)?.groups?.zone;
    if (call.path !== "/zones" && sending === undefined) {
      return undefined;
    }
    if (caller === undefined) {
      return refusal(403, 10_000, "Authentication error");
    }
    const reachable = [...accounts.values()].filter((account) =>
      isMember(account, caller)
    );
    const json: Json =
      typeof call.body === "object" && call.body !== null
        ? { ...call.body }
        : {};
    if (sending !== undefined) {
      const zone = reachable
        .flatMap(({ zones }) => zones)
        .find(({ id }) => id === sending);
      if (zone === undefined) {
        return refusal(403, 9109, "Unauthorized to access requested resource");
      }
      if (call.method === "GET") {
        return envelope(zone.sending);
      }
      const name = text(json, "name");
      if (name !== zone.name && !name.endsWith(`.${zone.name}`)) {
        return refusal(400, 1003, "Not a domain within the zone");
      }
      const existing = zone.sending.find((domain) => domain.name === name);
      const domain = existing ?? {
        tag: crypto.randomUUID().replaceAll("-", ""),
        name,
        enabled: true,
      };
      domain.enabled = true;
      if (existing === undefined) {
        zone.sending.push(domain);
      }
      return envelope(domain);
    }
    if (call.method === "GET") {
      const accountId = call.query.get("account.id");
      const name = call.query.get("name");
      return paged(
        reachable
          .filter(({ id }) => accountId === null || id === accountId)
          .flatMap(({ zones }) => zones)
          .filter((zone) => name === null || zone.name === name)
          .map(({ id, name: zoneName, status }) => ({
            id,
            name: zoneName,
            status,
          })),
        call.query
      );
    }
    const owner = z.object({ id: z.string() }).safeParse(json.account);
    const account = reachable.find(({ id }) => id === owner.data?.id);
    if (account === undefined) {
      return refusal(403, 9109, "Unauthorized to access requested resource");
    }
    const name = text(json, "name");
    if (
      [...accounts.values()].some(({ zones }) =>
        zones.some((zone) => zone.name === name)
      )
    ) {
      return refusal(400, 1061, `${name} already exists`);
    }
    const zone = {
      id: crypto.randomUUID().replaceAll("-", ""),
      name,
      status: "pending",
      sending: [],
    };
    account.zones.push(zone);
    return envelope({ id: zone.id, name, status: zone.status });
  };

  /** Answers `call` as the API would. */
  const respond = async (
    request: Request,
    call: ApiCall
  ): Promise<Response> => {
    const caller = callers.get(request.headers.get("authorization") ?? "");
    const unscoped = answerUnscoped(call, caller) ?? answerZones(call, caller);
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
   * What a Worker on an account's workers.dev subdomain answers: its live
   * version's `/health`, as core answers it, to a request carrying the
   * router secret that version has, the platform update notices it
   * takes, and the admin's signed requests it answers, its
   * provisioning probe among them. Undefined for any other host.
   */
  /**
   * The account and live version of the Worker a workers.dev `host`
   * names, when it's on workers.dev and has a version with the first share
   * of its traffic.
   */
  const workerAt = (host: { script?: string; subdomain?: string }) => {
    const account = [...accounts.values()].find(
      ({ subdomain }) => subdomain === host.subdomain
    );
    const script = account?.scripts.get(host.script ?? "");
    const [only] = script?.deployments[0]?.versions ?? [];
    const live = script?.versions.find(({ id }) => id === only?.version_id);
    return account === undefined ||
      live === undefined ||
      script?.subdomain?.enabled !== true
      ? undefined
      : { account, script, live };
  };

  /** What a workers.dev Worker's live version answers, as core does. */
  const workerAnswer = async (
    request: Request,
    url: URL,
    { account, script, live }: NonNullable<ReturnType<typeof workerAt>>
  ): Promise<Response> => {
    if (account.unhealthy !== undefined && account.unhealthy > 0) {
      account.unhealthy -= 1;
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
      return await signed(account, live, request);
    }
    if (url.pathname === quotaPolicyReportPath && request.method === "POST") {
      return await answerQuotaPolicy(account, script, live, request);
    }
    if (url.pathname === adminSnapshotPath && request.method === "POST") {
      adminReads.now += 1;
      adminReads.peak = Math.max(adminReads.peak, adminReads.now);
      try {
        // As fetch does: an aborted request ends at once, whatever its
        // core was still doing.
        return await Promise.race([
          answerAdmin(account, live, request),
          whenAborted(request.signal),
        ]);
      } finally {
        adminReads.now -= 1;
      }
    }
    if (url.pathname !== "/health") {
      return new Response("Not found", { status: 404 });
    }
    const [early, ...later] = account.healthAnswersFirst ?? [];
    account.healthAnswersFirst = later;
    return Response.json({
      ok: true,
      version: early ?? account.answeringVersion ?? live.id,
    });
  };

  const workersDev = async (
    request: Request,
    { followed = false }: { followed?: boolean } = {}
  ): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const host = /^(?<script>[^.]+)\.(?<subdomain>[^.]+)\.workers\.dev$/u.exec(
      url.hostname
    )?.groups;
    if (host === undefined) {
      return undefined;
    }
    const worker = workerAt(host);
    if (worker === undefined) {
      return new Response("There is nothing here yet", { status: 404 });
    }
    const { account } = worker;
    if (account.redirectsTo !== undefined && !followed) {
      // Its body unread: a redirect that's followed sends it on.
      return new Response(null, {
        status: 307,
        headers: { location: new URL(url.pathname, account.redirectsTo).href },
      });
    }
    return await workerAnswer(request, url, worker);
  };

  /**
   * The dispatch namespace `name` in account `accountId`, as a Worker
   * binding reaches it: only that account's namespace, as a real
   * DISPATCHER binds one namespace in its own account. Each script's live
   * version answers as a workers.dev Worker's does (`workerAnswer`); a
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
        account === undefined || script === undefined || live === undefined
          ? undefined
          : { account, script, live };
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

  /** What the API, or a Worker on workers.dev, answers `fetch(input, init)` with. */
  const answerFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const request = new Request(input, init);
    const served = await workersDev(request);
    const location = served?.headers.get("location");
    if (
      served !== undefined &&
      served.status === 307 &&
      typeof location === "string" &&
      request.redirect !== "manual"
    ) {
      // As fetch does: the same request, headers and body, to wherever
      // the redirect points. Whatever answers there answers as the core
      // would, as a host relaying to it would.
      redirected.push({
        url: location,
        routerSecret: request.headers.get("x-grasp-router-secret"),
      });
      return (await workersDev(request, { followed: true })) ?? served;
    }
    if (served !== undefined) {
      return served;
    }
    if (!request.url.startsWith(`${base}/`)) {
      throw new Error(`Unexpected outbound request to ${request.url}`);
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
    forgetDatabases();
    calls.length = 0;
    planned.clear();
    takenSubdomains.clear();
    matched.length = 0;
    interleaved.length = 0;
    answeredThen.length = 0;
    load.peak = 0;
    load.peakAccounts = 0;
    busyAccounts.clear();
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
    /** The most admin snapshot requests cores were answering at once in this test. */
    peakAdminReads: () => adminReads.peak,
    /** The requests a core's redirect sent elsewhere, in this test. */
    redirected: (): readonly { url: string; routerSecret: string | null }[] =>
      redirected,
    /** How many calls their caller aborted before they were answered, in this test. */
    abortedCalls: () => aborted.count,
    /** Adds an account the token is a member of, and returns what it holds. */
    addAccount,
    /** Fails the `n`th call from now as `failure` says, whatever it asks. */
    failCall: (n: number, failure: Failure) => {
      planned.set(calls.length + n, failure);
    },
    /** Takes `subdomain` for an account outside the test, as another customer's. */
    takeSubdomain: (subdomain: string) => {
      takenSubdomains.add(subdomain);
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
