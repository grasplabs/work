// An App's external links (spec 10.7.7, 32.3): which URL a screen may ask
// the page to open through its App's `resource.links` declaration, decided
// the same way by core (app-link-route.ts), which alone decides, and by
// the SDK as a declaration is checked. Apart and with nothing imported:
// the runtime in every screen's frame carries the message types, and
// can't bring Zod along (app-links.ts has the schemas).
//
// A URL is opened only when its own origin, as the URL standard parses
// it, is exactly one the declaration lists. Never by reading the text:
//
// - Userinfo (`https://help.example.com@evil.test`) is refused outright,
//   whatever the origin it parses to.
// - Unicode host names are matched as the ASCII (punycode) origin the
//   parser gives them; a declaration lists only ASCII origins, so a
//   look-alike in another script matches none.
// - Ports and trailing dots are part of the origin: `:443` is the default
//   and drops out, any other port must be declared, and a trailing dot
//   is another origin, which no declaration can list.
// - Only `https:`. Whitespace, controls, backslashes and bidirectional
//   formatting are refused before parsing, rather than quietly removed or
//   rewritten by the parser, so the URL opened is the one asked for.
// - IP addresses, host names ending in a dot or holding an empty label,
//   and private-network hosts are refused whatever was declared
//   (`isPrivateHost`); only origins a declaration may list
//   (`originRefusal`) count, whatever a manifest says.
// - Nothing is fetched or followed: a redirect is the declared origin's own.

/** Where core's link channel is: `<path>/<app>/<resource alias>/<check|open>`. */
export const appLinksPath = "/api/app-links";

/** The limits of a link, by what they bound. */
export const linkLimits = {
  /** The most UTF-16 code units of one URL. */
  urlLength: 2048,
} as const;

/** How a link was asked for: a click in the frame, or the host's dialog. */
export type LinkIntent = "activation" | "confirmation";

/** What a frame sends over its link port: one open, by its call number. */
export interface FrameLinkMessage {
  readonly type: "open";
  readonly call: number;
  readonly resource: string;
  readonly url: string;
}

/** A refusal, as the frame hears it: its code and message, nothing else. */
export interface LinkFailure {
  readonly code: string;
  readonly message: string;
}

/** What the page answers a frame's open with. */
export type PageLinkMessage =
  | { readonly type: "opened"; readonly call: number }
  | {
      readonly type: "failed";
      readonly call: number;
      readonly error: LinkFailure;
    };

/** Why a URL is no link to open. */
export type LinkRefusal =
  | "invalid"
  | "scheme"
  | "userinfo"
  | "host"
  | "ip_literal"
  | "private_network"
  | "origin";

/** A URL a declaration lets open, or why not. */
export type LinkTarget =
  | { readonly ok: true; readonly url: string; readonly origin: string }
  | { readonly ok: false; readonly reason: LinkRefusal };

/**
 * Characters a URL to open may not hold, though the parser would take it:
 * whitespace and controls it strips or rewrites, backslashes it reads as
 * slashes, and bidirectional or invisible formatting that shows the text
 * otherwise than it reads.
 */
const notInLink =
  // oxlint-disable-next-line no-control-regex -- controls are what it refuses
  /[\u0000-\u0020\u007F-\u009F\\\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/u;

/** A URL's authority, as written after `https://`. */
const authorityPattern = /^https:\/\/(?<authority>[^/?#]+)/iu;

/** Names that reach only the person's own machine or network. */
const privateNames = new Set(["localhost"]);

/** Suffixes of names that reach only a private network. */
const privateSuffixes = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".corp",
  ".home.arpa",
];

/** The four bytes of dotted-decimal IPv4 address `host`, if it is one. */
const ipv4Of = (host: string): readonly number[] | undefined => {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  const bytes = parts.map((part) =>
    /^(?:0|[1-9][0-9]{0,2})$/u.test(part) ? Number(part) : Number.NaN
  );
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : undefined;
};

/**
 * The IPv4 ranges outside the public internet, as their first address and
 * prefix length: this network, private, shared (carrier-grade NAT),
 * loopback, link-local, IETF protocol assignments, benchmarking,
 * multicast and reserved.
 */
const privateIpv4Ranges: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
];

/** IPv4 address `bytes` as one number. */
const ipv4Number = (bytes: readonly number[]): number =>
  bytes.reduce((number, byte) => number * 256 + byte, 0);

/** Whether IPv4 address `bytes` is outside the public internet. */
const isPrivateIpv4 = (bytes: readonly number[]): boolean => {
  const address = ipv4Number(bytes);
  return privateIpv4Ranges.some(([first, prefix]) => {
    const size = 2 ** (32 - prefix);
    const start = ipv4Number(ipv4Of(first) ?? []);
    return address >= start && address < start + size;
  });
};

/** The 16-bit groups of one side of an IPv6 address's `::`. */
const groupsOf = (text: string | undefined): number[] =>
  text === undefined || text === ""
    ? []
    : text
        .split(":")
        .map((group) =>
          /^[0-9a-f]{1,4}$/u.test(group)
            ? Number.parseInt(group, 16)
            : Number.NaN
        );

/**
 * The eight 16-bit groups of IPv6 address `host` (without its brackets),
 * as the URL standard serializes one: lower-case hex, `::` at most once,
 * never a dotted tail.
 */
const ipv6Of = (host: string): readonly number[] | undefined => {
  const halves = host.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const head = groupsOf(halves[0]);
  const tail = groupsOf(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  ) {
    return undefined;
  }
  const groups = [
    ...head,
    ...Array.from({ length: missing }, () => 0),
    ...tail,
  ];
  return groups.every((group) => !Number.isNaN(group)) ? groups : undefined;
};

/** The IPv4 address in the last 32 bits of IPv6 address `groups`. */
const embeddedIpv4 = (groups: readonly number[]): readonly number[] =>
  groups.slice(6).flatMap((group) => [Math.floor(group / 256), group % 256]);

/** Whether `groups` begins with `prefix`, group for group. */
const beginsWith = (
  groups: readonly number[],
  prefix: readonly number[]
): boolean => prefix.every((group, index) => groups[index] === group);

/**
 * Whether IPv6 address `groups` is outside the public internet:
 * unspecified, loopback and IPv4-compatible (`::/96`), an IPv4-mapped
 * (`::ffff:0:0/96`) or NAT64 (`64:ff9b::/96`) address of a private IPv4
 * one, unique local (`fc00::/7`), link-local (`fe80::/10`), site-local
 * (`fec0::/10`) or multicast (`ff00::/8`).
 */
const isPrivateIpv6 = (groups: readonly number[]): boolean => {
  const first = groups[0] ?? 0;
  const mapsPrivate =
    (beginsWith(groups, [0, 0, 0, 0, 0, 0xff_ff]) ||
      beginsWith(groups, [0x64, 0xff_9b, 0, 0, 0, 0])) &&
    isPrivateIpv4(embeddedIpv4(groups));
  return (
    beginsWith(groups, [0, 0, 0, 0, 0, 0]) ||
    mapsPrivate ||
    (first >= 0xfc_00 && first <= 0xfd_ff) ||
    first >= 0xfe_80
  );
};

/**
 * Whether host `host` (as a parsed URL's `hostname` has it: lower case,
 * punycode, an IPv6 address in brackets) reaches only the person's own
 * machine or a private network: loopback, private, link-local, shared,
 * multicast and reserved addresses, `localhost` and private-use names,
 * and a name of one label, which only a local resolver answers. Public
 * names that resolve to private addresses can't be told without
 * resolving them, which nothing here does: the browser navigates there,
 * core never does.
 */
export const isPrivateHost = (host: string): boolean => {
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  if (name.startsWith("[") && name.endsWith("]")) {
    const groups = ipv6Of(name.slice(1, -1));
    return groups === undefined || isPrivateIpv6(groups);
  }
  const ipv4 = ipv4Of(name);
  if (ipv4 !== undefined) {
    return isPrivateIpv4(ipv4);
  }
  return (
    !name.includes(".") ||
    privateNames.has(name) ||
    privateSuffixes.some(
      (suffix) => name === suffix.slice(1) || name.endsWith(suffix)
    )
  );
};

/** Whether host `host` (a parsed URL's `hostname`) is an IP address. */
export const isIpLiteral = (host: string): boolean =>
  (host.startsWith("[") && host.endsWith("]")) || ipv4Of(host) !== undefined;

/**
 * An exact HTTPS origin a links declaration may list: `https://`, a host
 * name of lower-case labels (never an IP address, never a trailing dot or
 * an empty label) and an optional port, with nothing after it, as the URL
 * standard serializes it.
 */
const declarableOriginPattern =
  /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/u;

/** The most UTF-16 code units of one declared origin. */
const originMaxLength = 253 + "https://".length + ":65535".length;

/**
 * Why `origin` may not be listed by a links declaration, or undefined when
 * it may: the SDK refuses a declaration listing one, and core opens no
 * link through one that slipped past (a manifest written otherwise).
 */
export const originRefusal = (
  origin: unknown
): "invalid" | "ip_literal" | "private_network" | undefined => {
  if (typeof origin !== "string" || origin.length > originMaxLength) {
    return "invalid";
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "https:" || url.origin !== origin) {
    return "invalid";
  }
  if (isIpLiteral(url.hostname)) {
    return "ip_literal";
  }
  if (!declarableOriginPattern.test(origin)) {
    return "invalid";
  }
  return isPrivateHost(url.hostname) ? "private_network" : undefined;
};

/**
 * Whether `url` may be opened through a links declaration listing exactly
 * `origins` (each an exact HTTPS origin, as the SDK checked it), and the
 * URL to open and its origin when it may (see the header).
 */
export const linkTargetOf = (
  url: unknown,
  origins: readonly string[]
): LinkTarget => {
  if (
    typeof url !== "string" ||
    url.length === 0 ||
    url.length > linkLimits.urlLength ||
    notInLink.test(url) ||
    !url.isWellFormed()
  ) {
    return { ok: false, reason: "invalid" };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "scheme" };
  }
  // Written out as `https://` and a host, never the forms the parser
  // repairs (`https:host`, `https:/host`): the authority is then the text
  // up to the path, and any `@` in it is userinfo, an empty one
  // (`https://:@host`) included, which the parser drops without a trace.
  const authority = authorityPattern.exec(url)?.groups?.authority;
  if (authority === undefined) {
    return { ok: false, reason: "invalid" };
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    authority.includes("@")
  ) {
    return { ok: false, reason: "userinfo" };
  }
  const host = parsed.hostname;
  if (host.endsWith(".") || host.split(".").includes("")) {
    return { ok: false, reason: "host" };
  }
  if (isIpLiteral(host)) {
    return { ok: false, reason: "ip_literal" };
  }
  if (isPrivateHost(host)) {
    return { ok: false, reason: "private_network" };
  }
  // Only origins a declaration may list count, whatever the manifest says.
  if (
    !origins.includes(parsed.origin) ||
    originRefusal(parsed.origin) !== undefined
  ) {
    return { ok: false, reason: "origin" };
  }
  return { ok: true, url: parsed.href, origin: parsed.origin };
};

/**
 * Whether Grasp may send an App's events to `url`, a company's webhook
 * (core's app-webhooks.ts, connect's webhooks.ts), and the URL to send to
 * when it may: any URL a link could open, under its own origin. So the
 * same rules hold: `https:` only, no userinfo, no IP address, no private
 * network name, nothing the parser would quietly rewrite.
 */
export const webhookTargetOf = (url: unknown): LinkTarget => {
  if (typeof url !== "string") {
    return { ok: false, reason: "invalid" };
  }
  let origin: string;
  try {
    ({ origin } = new URL(url));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  return linkTargetOf(url, [origin]);
};
