import { describe, expect, it } from "vite-plus/test";

import { connectorManifestSchema } from "../src/manifest.ts";
import { signInSchema } from "../src/sign-in.ts";
import type { SignInInput } from "../src/sign-in.ts";

// An app's provider record, as connect takes it: data that can't send a
// secret, a code or a token anywhere but the app's own HTTPS endpoints,
// can't take over what connect sets in a flow, and can't take a suite's
// place (connect's test/app-sign-in.test.ts has the threat model, AP3,
// AP4, AP6 and AP9 here).

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
  version: "1.0.0",
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

  it("AP9: takes no suite's place, and a suite's connector carries none", () => {
    expect(
      ["microsoft", "google", "composio", "Example"].filter(
        (provider) =>
          connectorManifestSchema.safeParse(manifest({ provider })).success
      )
    ).toStrictEqual([]);
    // An app without its record, which connect couldn't sign in to.
    expect(
      connectorManifestSchema.safeParse(manifest({ signIn: undefined })).success
    ).toBeFalsy();
  });
});
