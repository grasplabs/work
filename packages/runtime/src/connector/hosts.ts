// The hosts a connector declares (its manifest's `hosts`, its routes'
// hosts, the hosts its credential goes to), and how connect fills a host
// that differs per connection.

/**
 * A provider host, as the egress handler compares it: a lowercase DNS name
 * with at least two labels and a top-level label that starts with a letter,
 * so never an IP address, a port or userinfo.
 */
export const hostPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** One DNS label, as a template's `{name}` or a redirect host's `*` stands for. */
export const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/**
 * A host filled per connection: `{name}.<host>`, one DNS label under a
 * fixed name (`{company}.example.com`), or `{name}` alone, a whole
 * host only an admin sets, on a shared connection. A connector's code
 * sends its requests to the template's stand-in (`requestHost`); only
 * connect's egress fills it, with the host the connection signed in with
 * for it (`filledHost`).
 */
const hostTemplatePattern =
  /^\{(?<name>[a-z][a-z0-9]{0,31})\}(?:\.(?<suffix>.+))?$/u;

/**
 * A declared host's template: the name of its value, and the fixed name
 * under it (null for a whole host). Undefined for a fixed host, or a
 * template whose fixed name isn't a host.
 */
export const hostTemplateOf = (
  host: string
): { name: string; suffix: string | null } | undefined => {
  const groups = hostTemplatePattern.exec(host)?.groups;
  if (groups?.name === undefined) {
    return undefined;
  }
  const suffix = groups.suffix ?? null;
  return suffix === null || hostPattern.test(suffix)
    ? { name: groups.name, suffix }
    : undefined;
};

/** Names that never reach a host of a vendor's (RFC 6761). */
const specialNames = /\.(?:invalid|localhost)$/u;

/**
 * The host `value` names, a host or an HTTPS origin, as a URL parser
 * reads it (in lower case); none for anything else: a port, userinfo, a
 * path, a query, or a special-use name. A filled host still has to fit
 * its template.
 */
export const hostOf = (value: string): string | undefined => {
  const url = URL.parse(value.includes("://") ? value : `https://${value}`);
  return url?.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    !specialNames.test(url.hostname)
    ? url.hostname
    : undefined;
};

/**
 * The host a connector's code sends a declared host's requests to: a
 * fixed host itself; for a template, its name and fixed name under
 * `.invalid` (RFC 6761), which never resolves, as `company.example.com.invalid`
 * for `{company}.example.com`. fetch refuses a host with the template's
 * braces in it, and connector code never learns the host: egress fills it.
 */
export const requestHost = (declared: string): string => {
  const template = hostTemplateOf(declared);
  if (template === undefined) {
    return declared;
  }
  return template.suffix === null
    ? `${template.name}.invalid`
    : `${template.name}.${template.suffix}.invalid`;
};

/**
 * Whether `host` is one template `declared` stands for: a DNS name, one
 * label in front of the template's fixed name, or any host for a whole
 * host's template.
 */
export const fitsTemplate = (declared: string, host: string): boolean => {
  const template = hostTemplateOf(declared);
  if (template === undefined || !hostPattern.test(host)) {
    return false;
  }
  return (
    template.suffix === null ||
    (host.endsWith(`.${template.suffix}`) &&
      dnsLabel.test(host.slice(0, -(template.suffix.length + 1))))
  );
};

/**
 * The host `declared` stands for on a connection that signed in with
 * `hosts` (each template's host): itself if fixed, a template's host if
 * the connection has one that fits it.
 */
export const filledHost = (
  declared: string,
  hosts: Readonly<Record<string, string>>
): string | undefined => {
  if (hostPattern.test(declared)) {
    return declared;
  }
  const host = Object.hasOwn(hosts, declared) ? hosts[declared] : undefined;
  return host !== undefined && fitsTemplate(declared, host) ? host : undefined;
};
