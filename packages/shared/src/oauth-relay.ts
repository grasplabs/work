import { hkdfHmacKey } from "./client-secrets.ts";
import { connectionCallbackPath } from "./connect.ts";
import { fromBase64Url, toBase64Url } from "./encoding.ts";
import { clientDomain, authRelayHost, stages } from "./names.ts";
import type { Stage } from "./names.ts";
import { newClientIdSchema } from "./router.ts";

// The OAuth relay: one redirect URI host for every Grasp-hosted client.
// Google and Entra allow no wildcard in a redirect URI, so Grasp's shared
// OAuth apps can't name every `<id>.ongrasp.app`. Instead they name the
// relay's two paths on `auth.<hosted domain>` (@grasp-os/shared/names),
// and each stage's router sends a returning browser on to the client the
// flow belongs to, at that client's own callback.
//
// - A deployment behind the relay (its `SIGN_IN` names a `callbackOrigin`)
//   asks the IdP to return to the relay, and exchanges the code with that
//   same redirect URI. Without one, nothing changes: the IdP returns to
//   the deployment's own origin, as on-prem deployments with their own
//   OAuth apps have it.
// - Its core puts the client's hostname label in front of the OAuth state,
//   with when it did and an HMAC over all of it, keyed from the client's
//   router secret (`<label>.<issued>.<mac>[.<provider>].<state>`). The
//   router derives that secret from its own `ROUTER_KEY` and the client's
//   map entry, as it does for every request it forwards, so it holds no
//   client secret and the client none of the router's.
// - The router sends the browser on only for a state its client signed,
//   in the last `relayMaxAgeS`, to that client's hostname in the router's
//   own map: never to a host the request names, never to another client,
//   never anywhere for a client that isn't in the map (unknown, or
//   offboarded: offboarding takes the hostname out). It never sees a
//   token, never exchanges the code and logs only the client's hostname.
// - The client gets back the state it made, and checks it as ever: Better
//   Auth against its cookie and PKCE verifier, connect against its
//   one-time flow. So a replayed callback reaches only the client that
//   made it, whose state is already spent.

/** The relay's path for core's sign-in. Registered with Grasp's OAuth apps. */
export const signInRelayPath = "/callback/sign-in";

/** The relay's path for connect's account connections. Registered too. */
export const connectionsRelayPath = "/callback/connections";

/** Which flow a relay path is for. */
export type RelayKind = "sign-in" | "connections";

const relayPaths: Readonly<Record<RelayKind, string>> = {
  "sign-in": signInRelayPath,
  connections: connectionsRelayPath,
};

/** The flow the relay path `pathname` is for; undefined for any other path. */
export const relayKindOf = (pathname: string): RelayKind | undefined => {
  if (pathname === signInRelayPath) {
    return "sign-in";
  }
  if (pathname === connectionsRelayPath) {
    return "connections";
  }
  return undefined;
};

/** The relay's origin in `stage`. */
export const oauthRelayOrigin = (stage: Stage): string =>
  `https://${authRelayHost(stage)}`;

/** The stage whose relay origin `value` is exactly; undefined for any other value. */
export const relayStageOf = (value: string): Stage | undefined =>
  stages.find((stage) => oauthRelayOrigin(stage) === value);

/** The redirect URI a `kind` flow names behind the relay at `callbackOrigin`. */
export const relayRedirectUri = (
  callbackOrigin: string,
  kind: RelayKind
): string => `${callbackOrigin}${relayPaths[kind]}`;

/** A deployment behind the relay: its hostname label, and the stage it's hosted in. */
export interface RelayedClient {
  label: string;
  stage: Stage;
}

/**
 * The client at `origin` behind the relay at `callbackOrigin`: only when
 * `callbackOrigin` is a stage's relay origin, exactly, and `origin` is
 * `https://<label>.<that stage's hosted domain>`, with a label a client
 * can have. Null otherwise: the relay could never send its browser back.
 */
export const relayedClientOf = (
  origin: string,
  callbackOrigin: string
): RelayedClient | null => {
  const stage = relayStageOf(callbackOrigin);
  if (stage === undefined || !URL.canParse(origin)) {
    return null;
  }
  const url = new URL(origin);
  const suffix = `.${clientDomain(stage)}`;
  const label = url.hostname.slice(0, -suffix.length);
  if (
    url.origin !== origin ||
    url.protocol !== "https:" ||
    !url.hostname.endsWith(suffix) ||
    !newClientIdSchema.safeParse(label).success
  ) {
    return null;
  }
  return { label, stage };
};

/** A sign-in provider's id, as core's callback path names it. */
const providerPattern = /^[a-z][a-z-]{0,31}$/u;

/** Core's sign-in callback for `provider` (Better Auth's, under core's `/api/auth`). */
const signInCallbackPath = (provider: string): string =>
  `/api/auth/sso/callback/${provider}`;

/** What the relay's MAC keys are derived for, from a client's router secret. */
const relayPurpose = "grasp-os oauth relay key";

/** What every MAC covers first, so a format change can't pass for this one. */
const relayVersion = "grasp-oauth-relay-v1";

/**
 * How long after a flow starts the relay still sends its browser on:
 * longer than any flow lives (connect's are 10 minutes, Better Auth's
 * state 10 too), so only a callback replayed later than that is refused
 * at the relay rather than by the client.
 */
export const relayMaxAgeS = 15 * 60;

/** How far ahead of the router's clock a start may be. */
const relayFutureSkewS = 60;

/** The longest state the relay reads, so a huge one costs nothing. */
const relayMaxStateLength = 2048;

/** A MAC's length as base64url: HMAC-SHA256's 32 bytes. */
const macLength = 43;

const issuedPattern = /^[0-9a-z]{1,10}$/u;

const encoder = new TextEncoder();

/** A flow's state as its client made it, and what the relay adds. */
interface RelayedFlow {
  kind: RelayKind;
  label: string;
  /** The sign-in's provider; none for a connection. */
  provider?: string;
  /** The state the client made, which it gets back. */
  state: string;
  /** When the client put it through the relay, in seconds. */
  issuedAt: number;
}

/** What the MAC covers: every field, the client's state last, as it may hold anything. */
const macked = (flow: RelayedFlow): Uint8Array<ArrayBuffer> =>
  encoder.encode(
    [
      relayVersion,
      flow.kind,
      flow.label,
      String(flow.issuedAt),
      flow.provider ?? "",
      flow.state,
    ].join("\n")
  );

/**
 * The state a client behind the relay sends its IdP in place of `state`:
 * its label, when, the MAC with the key derived from `routerSecret` (its
 * `ROUTER_SECRET`), the provider for a sign-in, then its own state.
 * Throws for a label or provider the relay would refuse.
 */
export const relayState = async (
  routerSecret: string,
  flow: Omit<RelayedFlow, "issuedAt">,
  now: number = Date.now()
): Promise<string> => {
  const provider = flow.kind === "sign-in" ? (flow.provider ?? "") : undefined;
  if (
    !newClientIdSchema.safeParse(flow.label).success ||
    (provider !== undefined && !providerPattern.test(provider)) ||
    flow.state === ""
  ) {
    throw new Error("The relay would refuse this flow's state");
  }
  const issuedAt = Math.floor(now / 1000);
  const key = await hkdfHmacKey(routerSecret, relayPurpose, ["sign"]);
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      macked({ ...flow, provider, issuedAt })
    )
  );
  return [
    flow.label,
    issuedAt.toString(36),
    toBase64Url(mac),
    ...(provider === undefined ? [] : [provider]),
    flow.state,
  ].join(".");
};

/** A request to the relay, read: which client, which flow, and the MAC to check. */
export interface RelayRequest extends RelayedFlow {
  /** The client's hostname: `<label>.<hosted domain>`. */
  host: string;
  mac: Uint8Array<ArrayBuffer>;
}

/** A relayed state's parts; null when it hasn't the form. */
const partsOf = (kind: RelayKind, value: string) => {
  // The label, when, the MAC and the provider hold no dots; the client's
  // own state, last, may.
  const fixed = kind === "sign-in" ? 4 : 3;
  const parts = value.split(".");
  const state = parts.slice(fixed).join(".");
  const [label = "", issued = "", mac = "", provider] = parts;
  if (parts.length <= fixed || state === "") {
    return null;
  }
  return {
    label,
    issued,
    mac,
    provider: kind === "sign-in" ? provider : undefined,
    state,
  };
};

/**
 * Reads a request to the relay at `url` in `stage`: its flow, and the
 * client its state names. Null for anything but a relay path with
 * exactly one state of the relay's form, naming a label a client can
 * have; whether that client exists and signed it is the caller's to
 * check (`relayStateValid`).
 */
export const readRelayRequest = (
  url: URL,
  stage: Stage
): RelayRequest | null => {
  const kind = relayKindOf(url.pathname);
  const states = url.searchParams.getAll("state");
  const [value] = states;
  if (
    kind === undefined ||
    states.length !== 1 ||
    value === undefined ||
    value.length > relayMaxStateLength
  ) {
    return null;
  }
  const parts = partsOf(kind, value);
  if (
    parts === null ||
    !newClientIdSchema.safeParse(parts.label).success ||
    !issuedPattern.test(parts.issued) ||
    parts.mac.length !== macLength ||
    (parts.provider !== undefined && !providerPattern.test(parts.provider))
  ) {
    return null;
  }
  let mac: Uint8Array<ArrayBuffer>;
  try {
    mac = fromBase64Url(parts.mac);
  } catch {
    return null;
  }
  return {
    kind,
    label: parts.label,
    ...(parts.provider === undefined ? {} : { provider: parts.provider }),
    state: parts.state,
    issuedAt: Number.parseInt(parts.issued, 36),
    host: `${parts.label}.${clientDomain(stage)}`,
    mac,
  };
};

/**
 * Whether the client whose router secret is `routerSecret` signed
 * `request`'s state, no longer than `relayMaxAgeS` ago. In constant time.
 */
export const relayStateValid = async (
  routerSecret: string,
  request: RelayRequest,
  now: number = Date.now()
): Promise<boolean> => {
  const age = Math.floor(now / 1000) - request.issuedAt;
  if (age > relayMaxAgeS || age < -relayFutureSkewS) {
    return false;
  }
  const key = await hkdfHmacKey(routerSecret, relayPurpose, ["verify"]);
  return await crypto.subtle.verify("HMAC", key, request.mac, macked(request));
};

/**
 * Where the relay sends a browser `url` brought back: `request`'s
 * client's own callback for its flow, with every query parameter as the
 * IdP sent it, its refusals included, but `state`, which is the client's
 * own again. Built from the parsed parts alone, so no host, path or
 * header comes from the request.
 */
export const relayTarget = (url: URL, request: RelayRequest): string => {
  const path =
    request.kind === "sign-in"
      ? signInCallbackPath(request.provider ?? "")
      : connectionCallbackPath;
  const target = new URL(`https://${request.host}${path}`);
  for (const [name, value] of url.searchParams) {
    target.searchParams.append(name, name === "state" ? request.state : value);
  }
  return target.href;
};
