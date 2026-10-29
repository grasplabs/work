import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { jsonVar } from "@grasp-os/shared/config";
import { log } from "@grasp-os/shared/log";
import {
  residencyAllows,
  residencyEntryOf,
} from "@grasp-os/shared/model-residency";
import type { ResidencyEntry } from "@grasp-os/shared/model-residency";
import {
  defaultModelTransport,
  modelProviderKeysSchema,
  modelTransportConfigSchema,
  providerKeysNamed,
} from "@grasp-os/shared/model-transport";
import type {
  ModelProviderKeys,
  ModelTransport as TransportSetting,
  ModelTransportConfig,
} from "@grasp-os/shared/model-transport";

import { parseModelRef } from "./model-catalog.ts";
import type { ModelRef } from "./model-catalog.ts";
import { mayTry } from "./model-circuit.ts";
import type { EndpointPolicy } from "./model-endpoint-guard.ts";
import { cloudflareAiGateway } from "./model-transport-cloudflare.ts";
import {
  compatibleTransport,
  directTransport,
  openRouterTransport,
} from "./model-transport-direct.ts";
import type {
  ModelTransport,
  RouteMetadata,
  TransportRoute,
} from "./model-transport.ts";

// Which way a call goes: the deployment's transports (`MODEL_TRANSPORT`),
// in order, the first whose circuit is closed, that reaches the model, and
// whose route may carry the organization's calls (`residency`). Threat
// model, and how each is closed:
//
// - Residency bypass: every route is matched against the reviewed residency
//   catalog (@grasp-os/shared/model-residency) by its transport, the
//   model's provider and the host it actually sends to, never by what the
//   setting claims; an EU organization's call takes only an EU-capable
//   route, and failover is judged the same way, so it never leaves the
//   allowed set. Each request's host is checked again as it is sent
//   (models.ts, `open`). None fits: refused (`model.eu_only`,
//   because `residency`), audited, nothing sent.
// - Staff misconfiguration: a `MODEL_TRANSPORT` or `MODEL_PROVIDER_KEYS`
//   that doesn't parse leaves no transport at all (`model.unconfigured`):
//   it fails closed, never open onto a default that might be elsewhere; a
//   transport whose key is missing reaches nothing; a custom endpoint the
//   guard refuses reaches nothing.
// - Cost blow-up through failover: a call fails over only before a
//   request may have been billed (an open circuit, refused credentials, a
//   rate limit), at most once per transport, and every request it sends
//   is admitted and charged by the ledger like any other.
// - Key leakage through the config: keys are never in the var, only named.

/** The deployment's transport config, the default unless set; `undefined` when it doesn't parse. */
export const transportConfigOf = (env: {
  MODEL_TRANSPORT?: unknown;
}): ModelTransportConfig | undefined => {
  if (env.MODEL_TRANSPORT === undefined) {
    return defaultModelTransport;
  }
  const parsed = modelTransportConfigSchema.safeParse(
    jsonVar(env.MODEL_TRANSPORT)
  );
  if (!parsed.success) {
    log.error("model.transport_invalid", {
      paths: parsed.error.issues.map(({ path }) => path.join(".")).join(" "),
    });
    return undefined;
  }
  return parsed.data;
};

/**
 * The deployment's provider keys; none when the secret isn't set, and
 * none when it doesn't parse (logged by the paths that don't, never a
 * value).
 */
const providerKeysOf = (env: {
  MODEL_PROVIDER_KEYS?: string;
}): ModelProviderKeys => {
  if (env.MODEL_PROVIDER_KEYS === undefined || env.MODEL_PROVIDER_KEYS === "") {
    return {};
  }
  const parsed = modelProviderKeysSchema.safeParse(
    jsonVar(env.MODEL_PROVIDER_KEYS)
  );
  if (!parsed.success) {
    log.error("model.provider_keys_invalid", {
      paths: parsed.error.issues.map(({ path }) => path.join(".")).join(" "),
    });
    return {};
  }
  return parsed.data;
};

/** What the routing reads of core's env. */
export interface RoutingEnv {
  AI?: AiBinding;
  MODEL_TRANSPORT?: unknown;
  MODEL_PROVIDER_KEYS?: string;
  RUNTIME_PROFILE?: string;
}

/** Where a custom endpoint may point on this deployment. */
const endpointPolicyOf = (
  env: RoutingEnv,
  config: ModelTransportConfig
): EndpointPolicy => {
  // Plain workerd is on-prem: the only place a private host may be named.
  const onPrem = env.RUNTIME_PROFILE === "workerd" && env.AI === undefined;
  return { onPrem, privateHosts: onPrem ? config.privateHosts : [] };
};

/** The transport `setting` describes, or none it can't be on this deployment. */
const transportOf = (
  env: RoutingEnv,
  setting: TransportSetting,
  gateway: string | undefined,
  keys: ModelProviderKeys,
  policy: EndpointPolicy
): ModelTransport | undefined => {
  switch (setting.kind) {
    case "cloudflare-ai-gateway": {
      // Plain workerd (on-prem) has no AI binding, so no AI Gateway.
      return typeof env.AI?.fetch === "function" && gateway !== undefined
        ? cloudflareAiGateway(env.AI, gateway)
        : undefined;
    }
    case "openrouter": {
      return openRouterTransport(setting, keys, policy);
    }
    case "direct": {
      return directTransport(setting, keys, policy);
    }
    case "openai-compatible": {
      return compatibleTransport(setting, keys, policy);
    }
    default: {
      return undefined;
    }
  }
};

/** The deployment's transports, in order: the primary, then the failover ones. */
export interface Transports {
  config: ModelTransportConfig;
  /** Each transport, or none where it can't be on this deployment. */
  each: (ModelTransport | undefined)[];
}

/**
 * The deployment's transports, or `undefined` when `MODEL_TRANSPORT`
 * doesn't parse or none of them can be on this deployment: every call
 * then fails closed (`model.unconfigured`).
 */
export const transportsOf = (
  env: RoutingEnv,
  gateway: string | undefined
): Transports | undefined => {
  const config = transportConfigOf(env);
  if (config === undefined) {
    return undefined;
  }
  const keys = providerKeysOf(env);
  const policy = endpointPolicyOf(env, config);
  const each = [config.primary, ...config.failover].map((setting) =>
    transportOf(env, setting, gateway, keys, policy)
  );
  return each.some((transport) => transport !== undefined)
    ? { config, each }
    : undefined;
};

/** A route, with what the residency catalog says of it. */
export interface Routed {
  route: TransportRoute;
  /** Its transport's place: 0 for the primary, then the failover ones. */
  place: number;
  capabilities: ModelTransport["capabilities"];
  /** The catalog's entry for it; none for a route no entry matches. */
  residency: ResidencyEntry | undefined;
}

/** Why a transport was passed over for a call. */
export type PassedOver = "circuit_open" | "unreachable" | "residency";

/** The route a call takes, or why none. */
export type Routing =
  | { ok: true; routed: Routed; passed: { label: string; why: PassedOver }[] }
  | { ok: false; why: "residency" | "unreachable" | "circuit_open" };

/** The catalog's entry for `route`. */
export const residencyOfRoute = (
  route: TransportRoute
): ResidencyEntry | undefined =>
  residencyEntryOf({
    transport: route.transport,
    provider: route.provider,
    host: route.host,
    privateHost: route.privateHost,
  });

/**
 * The route `ref` takes, from the transports from `from` on (a call that
 * failed over asks again from the next one): the first whose circuit lets
 * it try, that reaches the model, on a route the organization's residency
 * allows. `residency` when some transport reached it but on no route the
 * residency allows; `unreachable` otherwise.
 */
export const routeCall = async (
  transports: Transports,
  ref: ModelRef,
  metadata: RouteMetadata,
  from = 0
): Promise<Routing> => {
  const passed: { label: string; why: PassedOver }[] = [];
  const { config, each } = transports;
  for (let place = from; place < each.length; place += 1) {
    const transport = each[place];
    if (transport === undefined) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- in order: the first that fits
    const route = await transport.route(ref, metadata);
    if (route === undefined) {
      passed.push({ label: transport.label, why: "unreachable" });
      continue;
    }
    const residency = residencyOfRoute(route);
    if (!residencyAllows(config.residency, residency, route.euAttested)) {
      passed.push({ label: transport.label, why: "residency" });
      continue;
    }
    // Circuits only where there is somewhere else to go: with one
    // transport, refusing fast would only turn the provider's outage into
    // the deployment's, and its own retries already wait as asked.
    if (each.length > 1 && !mayTry(transport.label)) {
      passed.push({ label: transport.label, why: "circuit_open" });
      continue;
    }
    return {
      ok: true,
      routed: { route, place, capabilities: transport.capabilities, residency },
      passed,
    };
  }
  if (passed.some(({ why }) => why === "residency")) {
    return { ok: false, why: "residency" };
  }
  return {
    ok: false,
    why: passed.some(({ why }) => why === "circuit_open")
      ? "circuit_open"
      : "unreachable",
  };
};

/** The keys `config`'s transports name that the deployment doesn't have: names only. */
export const missingProviderKeys = (
  env: RoutingEnv,
  config: ModelTransportConfig
): string[] => {
  const keys = providerKeysOf(env);
  return providerKeysNamed(config).filter((name) => !Object.hasOwn(keys, name));
};

/** The route an allowed model takes, as the admin is told it. */
export interface EffectiveRoute {
  model: string;
  transport: string | null;
  provider: string;
  host: string | null;
  route: string | null;
  region: string | null;
  allowed: boolean;
}

/** What a route to report on tells the transport: nothing of any call. */
const reportMetadata: RouteMetadata = {
  purpose: "platform.transport_report",
  actor: "system",
  requestId: undefined,
  runStep: undefined,
};

/**
 * The route each of `models` takes now, circuits aside: the first
 * transport that reaches it on a route the residency allows, else the
 * first that reaches it at all (not allowed), else none.
 */
export const effectiveRoutes = async (
  transports: Transports,
  models: readonly string[]
): Promise<EffectiveRoute[]> =>
  await Promise.all(
    models.map(async (model): Promise<EffectiveRoute> => {
      const ref = parseModelRef(model);
      const provider = ref?.provider ?? model.split("/")[0] ?? model;
      const none: EffectiveRoute = {
        model,
        transport: null,
        provider,
        host: null,
        route: null,
        region: null,
        allowed: false,
      };
      if (ref === undefined) {
        return none;
      }
      let first: EffectiveRoute | undefined = undefined;
      for (const transport of transports.each) {
        // oxlint-disable-next-line no-await-in-loop -- in order: the first that fits
        const route = await transport?.route(ref, reportMetadata);
        if (route !== undefined) {
          const residency = residencyOfRoute(route);
          const found: EffectiveRoute = {
            model,
            transport: route.label,
            provider,
            host: route.host,
            route: residency?.id ?? null,
            region: residency?.region ?? null,
            allowed: residencyAllows(
              transports.config.residency,
              residency,
              route.euAttested
            ),
          };
          if (found.allowed) {
            return found;
          }
          first ??= found;
        }
      }
      return first ?? none;
    })
  );
