/**
 * Connect's three outbound networks on plain workerd (on-prem, GRA-1481),
 * as pieces of capnp text for an install's workerd config: add `services`
 * to its services, `bindings` to connect's bindings, and set connect's
 * `globalOutbound` to `globalOutbound`.
 *
 * - Connect's own network, its `globalOutbound`: public addresses only.
 *   Every ordinary outside call goes through it (connectors, URL MCP
 *   servers, OAuth, webhooks), so a name that resolves inside gets nowhere.
 * - The AI endpoints' network (`AI_NETWORK`, apps/connect/src/ai-providers
 *   .ts): public addresses and `ai`, the address of each host
 *   `AI_PRIVATE_HOSTS` names, such as `10.0.0.8/32`.
 * - The company network (`COMPANY_NETWORK`, apps/connect/src/company-network
 *   .ts): `company`, the approved addresses of the connections reached
 *   through it, and nothing else; left out when there are none, so those
 *   connections are refused.
 *
 * Never `"private"` on any of them, which would let any name that resolves
 * to a private address through. Workerd checks each address a name
 * resolves to against the network's list, so DNS can't lead outside it;
 * within the company network it can lead to another approved address,
 * which is why an IP address is the safer setting there.
 */

/** The workerd services of connect's networks. */
const names = {
  public: "connect-public",
  ai: "connect-ai",
  company: "connect-company",
} as const;

const networkOf = (name: string, allow: readonly string[]): string =>
  `(name = "${name}", network = (allow = ${JSON.stringify(allow)}, tlsOptions = (trustBrowserCas = true)))`;

/** Connect's networks, for the AI CIDRs `ai` and the company CIDRs `company`. */
export const connectNetworks = (
  ai: readonly string[],
  company: readonly string[]
): { services: string[]; bindings: string[]; globalOutbound: string } => {
  const hasCompany = company.length > 0;
  return {
    services: [
      networkOf(names.public, ["public"]),
      networkOf(names.ai, ["public", ...ai]),
      ...(hasCompany ? [networkOf(names.company, company)] : []),
    ],
    bindings: [
      `(name = "AI_NETWORK", service = "${names.ai}")`,
      ...(hasCompany
        ? [`(name = "COMPANY_NETWORK", service = "${names.company}")`]
        : []),
    ],
    globalOutbound: `"${names.public}"`,
  };
};
