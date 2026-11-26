/**
 * An app each company has a host of its own at, under the vendor's name
 * (`acme.sample-company.test`), as connect's tests load it: one connector
 * written on `@grasp-os/sdk/connector` that signs in with OAuth 2.0, whose
 * token response names the company's host (`hostsFrom`), which connect
 * checks against its template and fills in as each request leaves. Its
 * authorization server and API are test/egress-credentials.test.ts's fake.
 */
import { auth, defineConnector, page, tool, v } from "@grasp-os/sdk/connector";

/** Where the app signs people in and issues tokens. */
export const sampleCompanyLoginHost = "login.sample-company.test";

/** Its host template: one label, the company's, under the app's name. */
export const sampleCompanyTemplate = "{company}.sample-company.test";

/** Where its token response names the company's host. */
export const sampleCompanyHostField = "api_domain";

const login = `https://${sampleCompanyLoginHost}`;

const Item = v.object({ id: v.string(), title: v.string() });
const Items = v.object({ items: v.array(Item) });

export default defineConnector({
  name: "sample-company",
  title: "Sample company app",
  hosts: [sampleCompanyTemplate],
  base: "/v1",
  auth: auth.oauth2({
    authorizeUrl: `${login}/oauth/authorize`,
    tokenUrl: `${login}/oauth/token`,
    scopes: { "items:read": "Read your items" },
    hostsFrom: { [sampleCompanyTemplate]: `/${sampleCompanyHostField}` },
    account: {
      url: `https://${sampleCompanyTemplate}/v1/me`,
      id: "/id",
      name: "/name",
      email: "/email",
    },
  }),
  tools: {
    "items.list": tool({
      description: "Lists your items",
      readOnly: true,
      reach: "own",
      scopes: ["items:read"],
      routes: ["GET /items"],
      args: {},
      returns: page(Item),
      handler: async (_args, api) => {
        const answer = await api.get("/items", { returns: Items });
        return { items: answer.items, next: null };
      },
    }),
  },
});
