// Where a custom model endpoint may point (MODEL_TRANSPORT's
// `openai-compatible`, src/model-transport-direct.ts). Its base URL is
// staff's or an on-prem operator's to set, so it is the one place a
// misconfiguration, or someone who got to the setting, could aim core's
// fetch at something other than a model: server-side request forgery.
// Threat model, and how each is closed:
//
// - A cloud metadata service (169.254.169.254, fd00:ec2::254,
//   metadata.google.internal, 100.100.100.200), which hands out the
//   host's credentials: refused always, on-prem too, whatever
//   `privateHosts` names.
// - The deployment's own network, or the machine itself (loopback,
//   RFC 1918, link-local, carrier-grade NAT, unique local IPv6, and names
//   such as `localhost` or `*.internal`): refused, except on-prem
//   (`RUNTIME_PROFILE=workerd`) for a host the deployment's own config
//   names in `privateHosts`. Hosted core runs on Cloudflare, whose fetch
//   doesn't reach private networks anyway; this refuses them before that.
// - A name that resolves to a private address (DNS rebinding): core can't
//   resolve names itself. On Cloudflare the fetch reaches public addresses
//   only; plain workerd's default network allows only public addresses
//   too (its `allow = ["public"]`), so an on-prem operator who opens it to
//   private ones has named the hosts they meant. Each request's URL is
//   checked again as it is sent (models.ts, `open`), so the host a request
//   goes to is always the one checked.
// - A redirect to somewhere else: requests to a custom endpoint don't
//   follow redirects (`redirect: "manual"`); a 3xx is a refusal.
// - A key sent in the clear: plain HTTP only to a private host on-prem,
//   which the operator named.
// - Credentials in the URL, or another port: a URL with a user or a
//   password is refused by the setting's schema
//   (@grasp-os/shared/model-transport), and only the default port, or any
//   port of a named private host, is taken.

/** Why an endpoint is refused, as logged and audited. */
export type EndpointRefusal =
  | "invalid_url"
  | "scheme"
  | "credentials"
  | "port"
  | "metadata_address"
  | "private_address";

/** Cloud metadata services, by every name and address they answer at. */
const metadataHosts: ReadonlySet<string> = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "100.100.100.200",
  "[fd00:ec2::254]",
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "instance-data",
  "instance-data.ec2.internal",
]);

/** Names that never leave the machine or its network. */
const localSuffixes = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home.arpa",
  ".corp",
];

const ipv4Pattern =
  /^(?<a>\d{1,3})\.(?<b>\d{1,3})\.(?<c>\d{1,3})\.(?<d>\d{1,3})$/u;

/** Whether `host` is an IPv4 address in a range that isn't the internet. */
const privateIpv4 = (host: string): boolean => {
  const match = ipv4Pattern.exec(host);
  if (match === null) {
    return false;
  }
  const a = Number(match.groups?.a);
  const b = Number(match.groups?.b);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
};

/**
 * Whether `host`, an IPv6 literal as a URL writes it (`[...]`), is outside
 * the internet: loopback, unspecified, unique local, link-local, an
 * IPv4-mapped address, or multicast. Any other bracketed host counts too:
 * a custom endpoint names a public host by name.
 */
const privateIpv6 = (host: string): boolean => host.startsWith("[");

/** Whether `host` names the machine or a private network. */
const privateHost = (host: string): boolean =>
  host === "localhost" ||
  !host.includes(".") ||
  localSuffixes.some((suffix) => host.endsWith(suffix)) ||
  privateIpv4(host) ||
  privateIpv6(host);

/** Where a custom endpoint may point, for this deployment. */
export interface EndpointPolicy {
  /** On-prem: plain workerd, on the deployment's own network. */
  onPrem: boolean;
  /** The private hosts the deployment's own config names (on-prem only). */
  privateHosts: readonly string[];
}

/** What a checked endpoint is. */
export interface CheckedEndpoint {
  url: URL;
  host: string;
  /** Whether it is one of the deployment's own private hosts (on-prem). */
  privateHost: boolean;
}

/**
 * `value` as an endpoint core may send to under `policy`, or why not.
 * Checked when a route is made and again for every request it sends.
 */
export const checkEndpoint = (
  value: string,
  policy: EndpointPolicy
): CheckedEndpoint | { refused: EndpointRefusal } => {
  const url = URL.parse(value);
  if (url === null) {
    return { refused: "invalid_url" };
  }
  if (url.username !== "" || url.password !== "") {
    return { refused: "credentials" };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (metadataHosts.has(host)) {
    return { refused: "metadata_address" };
  }
  const named = policy.onPrem && policy.privateHosts.includes(host);
  if (privateHost(host) && !named) {
    return { refused: "private_address" };
  }
  if (url.protocol !== "https:" && !(named && url.protocol === "http:")) {
    return { refused: "scheme" };
  }
  if (url.port !== "" && !named) {
    return { refused: "port" };
  }
  return { url, host, privateHost: named };
};
