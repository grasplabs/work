// Where an organization's OpenAI-compatible endpoint may point
// (ai-providers.ts). Its base URL is an admin's to set, so it is the one
// place a mistake, or someone who got to the setting, could aim connect's
// fetch, with a key, at something other than a model: server-side request
// forgery. Threat model, and how each is closed:
//
// - A cloud metadata service (169.254.169.254, fd00:ec2::254,
//   metadata.google.internal, 100.100.100.200), which hands out the
//   host's credentials: refused always, on-prem too, whatever
//   `AI_PRIVATE_HOSTS` names.
// - The deployment's own network, or the machine itself (loopback,
//   RFC 1918, link-local, carrier-grade NAT, unique local IPv6, and names
//   such as `localhost` or `*.internal`): refused, except on-prem
//   (`RUNTIME_PROFILE=workerd`) for a host the deployment's own config
//   names in `AI_PRIVATE_HOSTS`. Hosted connect runs on Cloudflare with
//   `global_fetch_strictly_public`, which doesn't reach private networks
//   anyway; this refuses them before that.
// - A name that resolves to a private address (DNS rebinding, or a
//   wildcard DNS name such as `127.0.0.1.nip.io` or
//   `169-254-169-254.attacker.example`): connect can't resolve names
//   itself (workerd has no DNS API, so nothing here can see the address a
//   name leads to, nor pin it for the fetch). So a name that carries an
//   address in it (four numeric labels in a row, a dashed quad, or a
//   wildcard DNS service such as nip.io or sslip.io) is refused outright,
//   wherever it points; on-prem, a private target is taken only as a name
//   or address `AI_PRIVATE_HOSTS` lists exactly. On Cloudflare,
//   `global_fetch_strictly_public` reaches public addresses only, so a
//   name that resolves to a private one fails there whatever it is.
//   The remaining limit, on plain workerd: an ordinary-looking name the
//   attacker's DNS answers with a private or metadata address passes this
//   check. What stops it there is workerd's network, never this guard:
//   its default (`allow = ["public"]`) reaches public addresses only, and
//   the on-prem setup opens it to each named host's own address alone
//   (`allow = ["public", "10.0.0.8/32"]`), never to `private` (env.d.ts,
//   `AI_PRIVATE_HOSTS`). The URL is checked when the key is saved and
//   again for every request, so the host a request goes to is always the
//   one checked.
// - A redirect to somewhere else: model requests don't follow redirects
//   (`redirect: "manual"`); a 3xx is a refusal.
// - A key sent in the clear: plain HTTP only to a private host on-prem,
//   which the operator named.
// - Credentials in the URL, or another port: a URL with a user or a
//   password is refused, and only the default port, or any port of a
//   named private host, is taken.

/** Why an endpoint is refused, as logged and audited. */
export type EndpointRefusal =
  | "invalid_url"
  | "scheme"
  | "credentials"
  | "port"
  | "metadata_address"
  | "private_address"
  | "address_in_name";

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

/**
 * Wildcard DNS services, which answer a name with the address written in
 * it (`10.0.0.1.nip.io`, `7f000001.nip.io`), in any of their forms.
 */
const wildcardDnsSuffixes = [
  "nip.io",
  "sslip.io",
  "xip.io",
  "nip.direct",
  "traefik.me",
  "localtest.me",
  "lvh.me",
  "vcap.me",
  "localhost.direct",
  "local.gd",
];

/** Four numeric labels in a row, anywhere in a name: `x.10.0.0.1.example`. */
const dottedQuadInName = /(?:^|\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\.|$)/u;

/** A label that is a dashed quad, as `169-254-169-254.example` writes one. */
const dashedQuadLabel = /(?:^|[.-])\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}(?:[.-]|$)/u;

/**
 * Whether `host`, a name rather than an address, carries an address in it
 * for a DNS server to answer with: a wildcard DNS service's name, or one
 * with a dotted or dashed quad among its labels. Such a name leads
 * wherever its writer chose, a private or metadata address included, and
 * connect can't resolve it to see (see the header).
 */
const addressInName = (host: string): boolean =>
  !ipv4Pattern.test(host) &&
  !host.startsWith("[") &&
  (wildcardDnsSuffixes.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  ) ||
    dottedQuadInName.test(host) ||
    dashedQuadLabel.test(host));

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
  if (addressInName(host) && !named) {
    return { refused: "address_in_name" };
  }
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
