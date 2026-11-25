import { describe, expect, it } from "vite-plus/test";

import { connectorManifestSchema } from "../../src/connector/manifest.ts";
import { signInSchema, tenantKinds } from "../../src/connector/sign-in.ts";
import type { SignInInput } from "../../src/connector/sign-in.ts";

// An app's provider record, as connect takes it: data that can't send a
// secret, a code or a token anywhere but the app's own HTTPS endpoints,
// can't take over what connect sets in a flow, and can't take another
// provider's place (connect's test/app-sign-in.test.ts and
// test/declared-sign-in.test.ts have the threat model, AP3, AP4, AP6, AP9
// and AP10 to AP16 here).

const apiHost = "api.example.test";

const oauth2 = {
  kind: "oauth2",
  name: "Example",
  authorizationEndpoint: "https://auth.example.test/oauth/authorize",
  tokenEndpoint: "https://auth.example.test/oauth/token",
  revocationEndpoint: "https://auth.example.test/oauth/revoke",
  scopes: ["read", "write"],
  account: { url: `https://${apiHost}/v1/me`, id: "/id" },
} satisfies SignInInput;

const apiKey = {
  kind: "api_key",
  name: "Example",
  header: "x-api-key",
  account: { url: `https://${apiHost}/v1/me`, id: "/id" },
} satisfies SignInInput;

/** A manifest of an app's connector, with `fields` instead. */
const manifest = (fields: Record<string, unknown>) => ({
  name: "example",
  provider: "example",
  signIn: oauth2,
  scopes: ["read"],
  hosts: [apiHost],
  actions: {},
  ...fields,
});

const refusedEndpoints = [
  // Plain HTTP: the secret and the code in the clear.
  "http://auth.example.test/oauth/token",
  // An address, a port, credentials, a fragment.
  "https://10.0.0.1/oauth/token",
  "https://[::1]/oauth/token",
  "https://auth.example.test:8443/oauth/token",
  "https://someone@auth.example.test/oauth/token",
  "https://auth.example.test/oauth/token#x",
  // What the parser would change: case, dot segments.
  "https://Auth.Example.test/oauth/token",
  "https://auth.example.test/a/../oauth/token",
  // Another scheme, or no URL at all.
  "data:text/plain,token",
  "file:///etc/passwd",
  "auth.example.test/oauth/token",
];

describe("an app's provider record", () => {
  it("takes the apps' sign-ins as they are", () => {
    expect(signInSchema.parse(oauth2)).toMatchObject({
      scopeSeparator: " ",
      authorizationParams: {},
      clientAuthentication: "client_secret_post",
    });
    expect(signInSchema.parse(apiKey)).toMatchObject({ header: "x-api-key" });
  });

  it("AP3: has its endpoints and lookup on HTTPS, on a DNS name, as written", () => {
    const accepted = refusedEndpoints.flatMap((endpoint) =>
      [
        { ...oauth2, authorizationEndpoint: endpoint },
        { ...oauth2, tokenEndpoint: endpoint },
        { ...oauth2, revocationEndpoint: endpoint },
        { ...apiKey, account: { ...apiKey.account, url: endpoint } },
      ]
        .filter((record) => signInSchema.safeParse(record).success)
        .map(() => endpoint)
    );
    expect(accepted).toStrictEqual([]);
    // Parameters past connect's checks, in the authorization endpoint.
    expect(
      signInSchema.safeParse({
        ...oauth2,
        authorizationEndpoint:
          "https://auth.example.test/oauth/authorize?request_uri=https://evil.test/r",
      }).success
    ).toBeFalsy();
    // The secret is posted: no query string to mix it into.
    expect(
      signInSchema.safeParse({
        ...oauth2,
        tokenEndpoint: "https://auth.example.test/oauth/token?client_secret=x",
      }).success
    ).toBeFalsy();
  });

  it("AP3: sends its lookup only to one of its connector's hosts", () => {
    expect(
      connectorManifestSchema.safeParse(manifest({})).success
    ).toBeTruthy();
    expect(
      connectorManifestSchema.safeParse(
        manifest({
          signIn: {
            ...oauth2,
            account: { url: "https://collector.evil.test/me", id: "/id" },
          },
        })
      ).success
    ).toBeFalsy();
  });

  it("AP4: can't set what connect sets in a flow, in any case, or ask for scopes its connector can't have", () => {
    const reserved = [
      "redirect_uri",
      "scope",
      "state",
      "code_challenge",
      "code_challenge_method",
      "client_id",
      "client_secret",
      "response_type",
      "request_uri",
      "request",
      "Redirect_URI",
      "resource",
      "authorization_details",
      "claims",
    ];
    expect(
      reserved.filter(
        (param) =>
          signInSchema.safeParse({
            ...oauth2,
            authorizationParams: { [param]: "https://evil.test" },
          }).success
      )
    ).toStrictEqual([]);
    // A connector's scopes are among its record's; an API key has none.
    expect(
      connectorManifestSchema.safeParse(manifest({ scopes: ["admin"] })).success
    ).toBeFalsy();
    expect(
      connectorManifestSchema.safeParse(
        manifest({ signIn: apiKey, scopes: ["read"] })
      ).success
    ).toBeFalsy();
    // Nor hold the separator it is joined with: it would be two at the app.
    expect(
      signInSchema.safeParse({
        ...oauth2,
        scopeSeparator: ",",
        scopes: ["items:read,items:write"],
      }).success
    ).toBeFalsy();
    // A scope can't break out of the parameter it is joined into.
    expect(
      signInSchema.safeParse({ ...oauth2, scopes: ["read write"] }).success
    ).toBeFalsy();
  });

  it("AP6: names no secret or binding of connect's: nothing but data it declares", () => {
    for (const extra of [
      { clientSecret: "APP_OAUTH_CLIENTS" },
      { clientIdVar: "MICROSOFT_CLIENT_ID" },
      { secretName: "GOOGLE_CLIENT_SECRET" },
    ]) {
      expect(
        signInSchema.safeParse({ ...oauth2, ...extra }).success
      ).toBeFalsy();
    }
  });

  it("AP7: puts an API key only in a header of its own, never one that carries it elsewhere", () => {
    const headers = [
      "cookie",
      "host",
      "forwarded",
      "x-forwarded-for",
      "proxy-authorization",
      "grasp-egress",
      "X-Api-Key",
      "x-api-key\r\nx-other",
    ];
    expect(
      headers.filter(
        (header) => signInSchema.safeParse({ ...apiKey, header }).success
      )
    ).toStrictEqual([]);
    expect(
      signInSchema.safeParse({ ...apiKey, prefix: "Bearer\r\n " }).success
    ).toBeFalsy();
    expect(
      signInSchema.parse({
        ...apiKey,
        header: "authorization",
        prefix: "Bearer ",
      })
    ).toMatchObject({ header: "authorization", prefix: "Bearer " });
  });

  it("AP9: takes no admin connection's, Composio's or a URL connector's name, and an app carries its record", () => {
    expect(
      [
        "composio",
        "Example",
        "microsoft-directory",
        "google-documents",
        "hibob-hr",
        `mcp_${"0".repeat(32)}`,
      ].filter(
        (provider) =>
          connectorManifestSchema.safeParse(manifest({ provider })).success
      )
    ).toStrictEqual([]);
    // An app without its record, which connect couldn't sign in to.
    expect(
      connectorManifestSchema.safeParse(manifest({ signIn: undefined })).success
    ).toBeFalsy();
    // A suite's connector may carry its own, or leave it to connect's.
    expect(
      ["microsoft", "google"].map((provider) => [
        connectorManifestSchema.safeParse(manifest({ provider })).success,
        connectorManifestSchema.safeParse(
          manifest({ provider, signIn: undefined, scopes: [] })
        ).success,
      ])
    ).toStrictEqual([
      [true, true],
      [true, true],
    ]);
  });
});

/** A record pinned to the tenant, its account from the ID token, as a suite's. */
const pinned = {
  kind: "oauth2",
  name: "Suite",
  authorizationEndpoint: "https://login.example.test/{tenant}/oauth2/authorize",
  tokenEndpoint: "https://login.example.test/{tenant}/oauth2/token",
  scopes: [
    "openid",
    "email",
    "offline_access",
    "Items.Read",
    "Items.ReadWrite",
  ],
  authorizationParams: { domain_hint: "{tenant}" },
  tenant: "guid",
  idToken: {
    issuer: "https://login.example.test/{tenant}/v2.0",
    subject: "oid",
    email: ["email"],
    claims: { tid: "{tenant}" },
    sameIssuer: ["idp"],
  },
} satisfies SignInInput;

const accepts = (record: Record<string, unknown>): boolean =>
  signInSchema.safeParse({ ...pinned, ...record }).success;

describe("a record pinned to a tenant, as a suite's", () => {
  it("takes a suite's sign-in as it is", () => {
    expect(signInSchema.parse(pinned)).toMatchObject({
      tenant: pinned.tenant,
      idToken: pinned.idToken,
    });
    // Google's: two issuers, one a bare name, and the tenant in a claim.
    expect(
      accepts({
        authorizationEndpoint: "https://accounts.example.test/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.example.test/token",
        authorizationParams: { hd: "{tenant}", prompt: "consent" },
        tenant: "domain",
        idToken: {
          issuer: ["https://accounts.example.test", "accounts.example.test"],
          subject: "sub",
          name: ["email"],
          email: ["email"],
          claims: { hd: "{tenant}", email_verified: true },
        },
      })
    ).toBeTruthy();
  });

  it("AP10: puts the tenant only past an endpoint's host, and takes only a GUID or a domain", () => {
    const templates = [
      // In the host: the tenant would choose where the code goes.
      "https://{tenant}.example.test/oauth2/token",
      "https://login.example.test.{tenant}/oauth2/token",
      "https://{tenant}/oauth2/token",
      "https://login{tenant}.example.test/oauth2/token",
      // In a query: a parameter of the tenant's choosing.
      "https://login.example.test/oauth2/token?tenant={tenant}",
    ];
    expect(
      templates.filter(
        (endpoint) =>
          accepts({ tokenEndpoint: endpoint }) ||
          accepts({ authorizationEndpoint: endpoint })
      )
    ).toStrictEqual([]);
    // RFC 7009's endpoint is called with no tenant: none to fill.
    expect(
      accepts({
        revocationEndpoint: "https://login.example.test/{tenant}/oauth2/revoke",
      })
    ).toBeFalsy();
    // Only the kinds connect knows, never a pattern of the record's own.
    expect(
      ["any", { pattern: ".*" }].filter((tenant) => accepts({ tenant }))
    ).toStrictEqual([]);
    const tenant = "11111111-1111-4111-8111-111111111111";
    const { guid, domain } = tenantKinds;
    expect({
      guid: guid.test(tenant),
      longer: guid.test(`${tenant}0`),
      within: guid.test(`x${tenant}`),
      domain: domain.test("acme.test"),
      // A tenant is never more than a name.
      path: domain.test("evil.test/oauth2"),
      query: domain.test("a?b=c"),
      host: domain.test("user@evil.test"),
      port: domain.test("evil.test:8443"),
      dots: domain.test(".."),
      escaped: domain.test("a%2fb.test"),
      upper: domain.test("Acme.Test"),
      label: domain.test("acme"),
    }).toStrictEqual({
      guid: true,
      longer: false,
      within: false,
      domain: true,
      path: false,
      query: false,
      host: false,
      port: false,
      dots: false,
      escaped: false,
      upper: false,
      label: false,
    });
  });

  it("AP11: names its issuers exactly: HTTPS or a DNS name, the tenant never in the host", () => {
    expect(
      [
        "*",
        "",
        "https://*.example.test",
        "http://login.example.test/{tenant}/v2.0",
        "https://login.example.test/{tenant}/v2.0?x=1",
        "https://login.example.test:8443/{tenant}/v2.0",
        "https://{tenant}.example.test/v2.0",
        "{tenant}.example.test",
        "https://10.0.0.1/v2.0",
      ].filter((issuer) => accepts({ idToken: { ...pinned.idToken, issuer } }))
    ).toStrictEqual([]);
    expect(accepts({ idToken: { ...pinned.idToken, issuer: [] } })).toBeFalsy();
    // `iss` and `aud` are connect's to check, against the issuer and its client.
    expect(
      [
        { claims: { aud: "any" } },
        { claims: { iss: "any" } },
        { sameIssuer: ["iss"] },
        { subject: "aud" },
      ].filter((check) => accepts({ idToken: { ...pinned.idToken, ...check } }))
    ).toStrictEqual([]);
  });

  it("AP19: confirms an address again only at a userinfo endpoint on one of its connector's hosts, for an address its ID token names", () => {
    const userinfo = `https://${apiHost}/v1/userinfo`;
    expect(accepts({ idToken: { ...pinned.idToken, userinfo } })).toBeTruthy();
    const { email: _email, ...withoutEmail } = pinned.idToken;
    expect(accepts({ idToken: { ...withoutEmail, userinfo } })).toBeFalsy();
    expect(
      refusedEndpoints.filter((each) =>
        accepts({ idToken: { ...pinned.idToken, userinfo: each } })
      )
    ).toStrictEqual([]);
    const onHosts = (url: string): boolean =>
      connectorManifestSchema.safeParse(
        manifest({
          signIn: { ...pinned, idToken: { ...pinned.idToken, userinfo: url } },
          scopes: ["Items.Read"],
        })
      ).success;
    expect(onHosts(userinfo)).toBeTruthy();
    expect(onHosts("https://collector.evil.test/v1/userinfo")).toBeFalsy();
  });

  it("AP12: checks its tenant in the ID token, and fills a tenant only where it has one", () => {
    const { tenant: _tenant, ...unpinned } = pinned;
    expect({
      // An account of any tenant would do: with no claim of it, an issuer
      // without the tenant takes every tenant's tokens.
      mixedIssuers: accepts({
        idToken: {
          issuer: [
            "https://login.example.test/{tenant}/v2.0",
            "https://login.example.test/common/v2.0",
          ],
          subject: "oid",
        },
      }),
      noClaim: accepts({
        idToken: {
          issuer: "https://login.example.test/common/v2.0",
          subject: "oid",
          claims: {},
        },
      }),
      lookup: accepts({
        idToken: undefined,
        account: { url: "https://api.example.test/me", id: "/id" },
      }),
      // An ID token can't come without the openid scope, in every consent.
      noOpenid: accepts({ scopes: ["email", "Items.Read"] }),
      openidByClass: accepts({
        rights: {
          signIn: ["email", "offline_access"],
          classes: {
            "read-own": ["openid", "Items.Read"],
            "change-own": ["Items.ReadWrite"],
            "read-company": [],
            "change-company": [],
            "reach-others": [],
            "read-others": [],
          },
        },
      }),
      // Neither an account nor an ID token, or both.
      neither: accepts({ idToken: undefined }),
      both: accepts({
        account: { url: "https://api.example.test/me", id: "/id" },
      }),
      // A tenant to fill, with no tenant.
      unpinned: signInSchema.safeParse(unpinned).success,
      unpinnedParam: signInSchema.safeParse({
        ...unpinned,
        authorizationEndpoint: "https://login.example.test/common/authorize",
        tokenEndpoint: "https://login.example.test/common/token",
        idToken: {
          ...pinned.idToken,
          issuer: "https://login.example.test/common/v2.0",
          claims: {},
        },
      }).success,
    }).toStrictEqual({
      mixedIssuers: false,
      noClaim: false,
      lookup: false,
      noOpenid: false,
      openidByClass: false,
      neither: false,
      both: false,
      unpinned: false,
      unpinnedParam: false,
    });
  });

  it("AP14: asks by class for each of its scopes and nothing beyond, and requires at renewal only what every consent asks", () => {
    const rights = {
      signIn: ["openid", "email", "offline_access"],
      classes: {
        "read-own": ["Items.Read"],
        "change-own": ["Items.ReadWrite"],
        "read-company": [],
        "change-company": [],
        "reach-others": [],
        "read-others": [],
      },
      implied: { "Items.ReadWrite": ["Items.Read"] },
    };
    expect(
      accepts({ rights, renewalRequires: ["offline_access"] })
    ).toBeTruthy();
    const beyond = [
      { rights: { ...rights, signIn: [...rights.signIn, "Admin"] } },
      {
        rights: {
          ...rights,
          classes: { ...rights.classes, "reach-others": ["Items.Send"] },
        },
      },
      { rights: { ...rights, implied: { "Items.Admin": ["Items.Read"] } } },
      {
        rights: { ...rights, implied: { "Items.ReadWrite": ["Items.Admin"] } },
      },
      {
        rights: {
          ...rights,
          sharedMailbox: { read: ["Items.Read.Shared"], reach: [] },
        },
      },
      { renewalRequires: ["Items.Admin"] },
      // A class's scope required at renewal: off, it is never asked again.
      { rights, renewalRequires: ["Items.ReadWrite"] },
      // A scope no class, sign-in or shared mailbox ever asks for.
      {
        rights: {
          ...rights,
          classes: { ...rights.classes, "change-own": [] },
          implied: {},
        },
      },
      // A class it doesn't name, or one it leaves out.
      { rights: { ...rights, classes: { ...rights.classes, "read-all": [] } } },
      {
        rights: {
          ...rights,
          classes: { "read-own": ["Items.Read"] },
        },
      },
    ];
    expect(beyond.filter((record) => accepts(record))).toStrictEqual([]);
    // What a scope takes in, it lists whole, as Microsoft's table does.
    const files = {
      scopes: [
        ...rights.signIn,
        "Files.Read",
        "Files.ReadWrite",
        "Files.Read.All",
        "Files.ReadWrite.All",
      ],
      rights: {
        ...rights,
        classes: {
          ...rights.classes,
          "read-own": ["Files.Read"],
          "change-own": ["Files.ReadWrite"],
          "read-company": ["Files.Read.All"],
          "change-company": ["Files.ReadWrite.All"],
        },
        implied: {
          "Files.ReadWrite.All": [
            "Files.ReadWrite",
            "Files.Read.All",
            "Files.Read",
          ],
          "Files.ReadWrite": ["Files.Read"],
          "Files.Read.All": ["Files.Read"],
        },
      },
    };
    expect(accepts(files)).toBeTruthy();
    const tangled = [
      // A chain it leaves open: Files.Read only through Files.ReadWrite.
      {
        ...files.rights.implied,
        "Files.ReadWrite.All": ["Files.ReadWrite", "Files.Read.All"],
      },
      // A cycle, and a scope that takes itself in.
      { "Files.ReadWrite": ["Files.Read"], "Files.Read": ["Files.ReadWrite"] },
      { "Files.Read": ["Files.Read"] },
    ];
    expect(
      tangled.filter((implied) =>
        accepts({ ...files, rights: { ...files.rights, implied } })
      )
    ).toStrictEqual([]);
  });

  it("AP15: has a scope prefix only as a URL no scope of its starts with, and no scope twice in another case", () => {
    // Compared without case, two scopes would be one.
    expect(accepts({ scopes: [...pinned.scopes, "items.read"] })).toBeFalsy();
    expect(accepts({ scopePrefix: "https://api.example.test/" })).toBeTruthy();
    expect(
      [
        "Items.",
        "https://api.example.test",
        "http://api.example.test/",
        "https://api.example.test/?x=",
        // Its own scope would be stripped into another's name.
        "https://login.example.test/",
      ].filter((scopePrefix) =>
        accepts({
          scopePrefix,
          scopes: [...pinned.scopes, "https://login.example.test/Items.Read"],
        })
      )
    ).toStrictEqual([]);
  });
});
