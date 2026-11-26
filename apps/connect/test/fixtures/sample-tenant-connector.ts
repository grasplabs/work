/**
 * A suite-like app, as connect's tests load it: one connector written on
 * `@grasp-os/sdk/connector` whose sign-in says all a suite's config does,
 * and no change to connect. Its flow is pinned to the organization's
 * tenant (a GUID, in its endpoints' paths and a parameter), its account
 * is read from the OpenID ID token, it asks by tool class, its token
 * answers may prefix a scope with its API's URL, a renewal must still hold
 * its sign-in's read of the account, and revoking one token revokes the
 * account's whole grant.
 * Its authorization server is test/declared-sign-in.test.ts's fake.
 */
import { auth, defineConnector, page, tool, v } from "@grasp-os/sdk/connector";

/** Where the app signs people in and issues tokens. */
export const sampleTenantLoginHost = "login.sample-tenant.test";

/** The app's API, which its connector calls. */
export const sampleTenantApiHost = "api.sample-tenant.test";

/** What its token answers may put before a scope. */
export const sampleTenantScopePrefix = `https://${sampleTenantApiHost}/`;

const login = `https://${sampleTenantLoginHost}`;

const Item = v.object({ id: v.string(), title: v.string() });
const Items = page(Item);

export default defineConnector({
  name: "sample-tenant",
  title: "Sample tenant app",
  hosts: [sampleTenantApiHost],
  auth: auth.oauth2({
    authorizeUrl: `${login}/{tenant}/oauth2/authorize`,
    tokenUrl: `${login}/{tenant}/oauth2/token`,
    revokeUrl: `${login}/oauth2/revoke`,
    scopes: {
      openid: "Sign you in",
      profile: "Read your profile",
      email: "Read your address",
      offline_access: "Stay signed in",
      "Account.Read": "Read your account",
      "Account.ReadWrite": "Change your account",
      "Items.Read": "Read your items",
      "Items.ReadWrite": "Change your items",
      "Items.Send": "Send items to others",
      "Items.Read.Shared": "Read shared boards",
      "Items.Send.Shared": "Send from shared boards",
    },
    params: { domain_hint: "{tenant}" },
    tenant: "guid",
    idToken: {
      issuer: `${login}/{tenant}/v2.0`,
      subject: "oid",
      name: ["preferred_username"],
      email: ["email", "preferred_username"],
      claims: { tid: "{tenant}" },
      sameIssuer: ["idp"],
    },
    rights: {
      signIn: ["openid", "profile", "email", "offline_access", "Account.Read"],
      classes: {
        "read-own": ["Items.Read"],
        "change-own": ["Items.ReadWrite"],
        "read-company": [],
        "change-company": ["Account.ReadWrite"],
        "reach-others": ["Items.Send"],
        "read-others": [],
      },
      implied: {
        "Items.ReadWrite": ["Items.Read"],
        // What a renewal requires, taken in by a class's right.
        "Account.ReadWrite": ["Account.Read"],
      },
      sharedMailbox: {
        read: ["Items.Read.Shared"],
        reach: ["Items.Send.Shared"],
      },
    },
    scopePrefix: sampleTenantScopePrefix,
    renewalRequires: ["Account.Read"],
    grant: "account",
  }),
  tools: {
    "v1.boards.items.list": tool({
      description: "Lists the items on a board",
      readOnly: true,
      reach: "own",
      scopes: ["Items.Read"],
      resource: "board",
      routes: ["GET /v1/boards/{board}/items"],
      args: { board: v.string().segment() },
      returns: Items,
      handler: async ({ board }, api) =>
        await api.get("/v1/boards/{board}/items", {
          path: { board },
          returns: Items,
        }),
    }),
  },
});
