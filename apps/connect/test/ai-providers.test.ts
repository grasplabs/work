/**
 * The AI providers' credentials in connect (src/ai-providers.ts): the
 * organization's own keys, sealed here, Grasp's own as secrets, and the
 * one place a model request leaves with one (`modelFetch`). The providers
 * are the outside system, faked behind fetch.
 *
 * The ways it can fail come first, deliberate attacks among them: a
 * request without core's grant, or with one for another host; a key sent
 * to another host, another path, in two headers, or after a redirect; a
 * credential of core's own; a custom endpoint aimed at a private,
 * internal or metadata address; a key read back, logged, or opened after
 * its row was tampered with. Then what it is for.
 */
import {
  aiCredentialPlaceholder,
  aiKeyErrors,
  aiRefusedHeader,
} from "@grasp-os/shared/ai-providers";
import { signModelGrant } from "@grasp-os/shared/capability";
import type { ModelGrantScope } from "@grasp-os/shared/capability";
import { env } from "cloudflare:workers";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { checkEndpoint } from "../src/ai-endpoint-guard.ts";
import type { EndpointPolicy } from "../src/ai-endpoint-guard.ts";
import { resealAiProviderKeys } from "../src/ai-providers.ts";
import { appFor, capabilityFor, connectWith } from "./connect.ts";
import { fakeInternet } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";

// The OAuth providers' spy on fetch first, as the internet's expects.
fakeProviders();

/** What the providers answer next, by default a short stream. */
let nextAnswer: () => Response | Promise<Response> = () =>
  new Response("data: {}\n\n", {
    headers: {
      "content-type": "text/event-stream",
      "request-id": "req_1",
      "set-cookie": "session=provider",
      [aiRefusedHeader]: "grant",
    },
  });

const { sent } = fakeInternet(async () => await nextAnswer());

/** Grasp's own key at OpenAI, as a connect secret. */
const platformKey = "test-platform-openai-key-0001";

const connect = (vars: Partial<Env> = {}) =>
  connectWith({ OPENAI_API_KEY: platformKey, ...vars });

/** A key no other test uses. */
const newKey = (): string => `test-byok-${crypto.randomUUID()}`;

/** The grant core signs for one request, made with connect's key. */
const grantFor = async (
  scope: Partial<ModelGrantScope> & Pick<ModelGrantScope, "provider" | "host">,
  key: string = env.CAPABILITY_SIGNING_KEY
): Promise<string> =>
  await signModelGrant(key, {
    credential: "organization",
    request: crypto.randomUUID(),
    notAfter: Date.now() + 60_000,
    ...scope,
  });

/** A model request as pi's adapter makes it, with the placeholder. */
const modelRequest = (
  url: string,
  {
    method = "POST",
    headers = { authorization: `Bearer ${aiCredentialPlaceholder}` },
  }: { method?: string; headers?: Record<string, string> } = {}
): Request =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "GET" ? null : JSON.stringify({ model: "gpt-5.4" }),
  });

/** The code connect refused a key with, or "ok" if it kept it. */
const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return aiKeyErrors.codeOf(error) ?? String(error);
  }
};

/** Why connect refused a model request; `sent` when it went on. */
const refusalOf = (response: Response): string =>
  response.headers.get(aiRefusedHeader) ?? "sent";

const openAiUrl = "https://api.openai.com/v1/responses";

describe("AI providers in connect", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ai_provider_keys").run();
    nextAnswer = () =>
      new Response("data: {}\n\n", {
        headers: {
          "content-type": "text/event-stream",
          "request-id": "req_1",
          "set-cookie": "session=provider",
          [aiRefusedHeader]: "grant",
        },
      });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("a model request connect refuses before it leaves", () => {
    it("refuses one without core's grant: none, forged, expired, or a connector's capability", async () => {
      await connect().saveAiProviderKey({ provider: "openai", key: newKey() });
      const scope = { provider: "openai", host: "api.openai.com" } as const;
      // A connector call's capability, made with the same key.
      const capability = await capabilityFor(appFor("user-1"), {
        connectionId: "connection-1",
        action: "mail.read",
        input: {},
      });
      const grants = [
        undefined,
        "not-a-grant",
        await grantFor(scope, "another-signing-key-of-32-characters-or-more"),
        await signModelGrant(
          env.CAPABILITY_SIGNING_KEY,
          {
            credential: "organization",
            request: crypto.randomUUID(),
            notAfter: Date.now(),
            ...scope,
          },
          Date.now() - 120_000
        ),
        capability,
      ];

      const refusals = await Promise.all(
        grants.map(async (grant) =>
          refusalOf(await connect().modelFetch(modelRequest(openAiUrl), grant))
        )
      );

      expect(refusals).toStrictEqual(Array.from(grants, () => "grant"));
      expect(sent).toStrictEqual([]);
    });

    it("refuses a request to any host but its provider's, or the one its grant names", async () => {
      await connect().saveAiProviderKey({ provider: "openai", key: newKey() });
      const elsewhere = [
        // Another host, with a grant for it.
        ["https://attacker.example/v1/responses", "attacker.example"],
        // The provider's host, with a grant for another.
        [openAiUrl, "api.anthropic.com"],
        // A grant for the provider's host, to another.
        ["https://api.anthropic.com/v1/messages", "api.openai.com"],
        ["http://api.openai.com/v1/responses", "api.openai.com"],
        ["https://api.openai.com:8443/v1/responses", "api.openai.com"],
      ] as const;

      const refusals = await Promise.all(
        elsewhere.map(async ([url, host]) =>
          refusalOf(
            await connect().modelFetch(
              modelRequest(url),
              await grantFor({ provider: "openai", host })
            )
          )
        )
      );

      expect(refusals).toStrictEqual(elsewhere.map(() => "endpoint"));
      expect(sent).toStrictEqual([]);
    });

    it("refuses what isn't a model request: another path, method or query, or a credential of core's own", async () => {
      await connect().saveAiProviderKey({ provider: "openai", key: newKey() });
      const grant = await grantFor({
        provider: "openai",
        host: "api.openai.com",
      });

      const refusals = {
        files: refusalOf(
          await connect().modelFetch(
            modelRequest("https://api.openai.com/v1/files"),
            grant
          )
        ),
        organization: refusalOf(
          await connect().modelFetch(
            modelRequest("https://api.openai.com/v1/organization/api_keys"),
            grant
          )
        ),
        query: refusalOf(
          await connect().modelFetch(
            modelRequest(`${openAiUrl}?api-version=2026`),
            grant
          )
        ),
        method: refusalOf(
          await connect().modelFetch(
            modelRequest(openAiUrl, { method: "GET" }),
            grant
          )
        ),
        ownKey: refusalOf(
          await connect().modelFetch(
            modelRequest(openAiUrl, {
              headers: { authorization: "Bearer sk-core-of-its-own" },
            }),
            grant
          )
        ),
        noKey: refusalOf(
          await connect().modelFetch(
            modelRequest(openAiUrl, { headers: {} }),
            grant
          )
        ),
      };

      expect(refusals).toStrictEqual({
        files: "path",
        organization: "path",
        query: "endpoint",
        method: "method",
        ownKey: "credential_header",
        noKey: "credential_header",
      });
      expect(sent).toStrictEqual([]);
    });

    it("refuses a provider the organization has no key for, and one Grasp has none for", async () => {
      const organization = await connect().modelFetch(
        modelRequest("https://api.mistral.ai/v1/chat/completions"),
        await grantFor({ provider: "mistral", host: "api.mistral.ai" })
      );
      const platform = await connect().modelFetch(
        modelRequest("https://api.mistral.ai/v1/chat/completions"),
        await grantFor({
          provider: "mistral",
          host: "api.mistral.ai",
          credential: "platform",
        })
      );

      expect([refusalOf(organization), refusalOf(platform)]).toStrictEqual([
        "no_credential",
        "no_credential",
      ]);
      expect(sent).toStrictEqual([]);
    });

    it("never follows a redirect, which would take the key along", async () => {
      await connect().saveAiProviderKey({ provider: "openai", key: newKey() });
      nextAnswer = () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://attacker.example/v1/responses" },
        });

      const response = await connect().modelFetch(
        modelRequest(openAiUrl),
        await grantFor({ provider: "openai", host: "api.openai.com" })
      );

      expect(refusalOf(response)).toBe("redirect");
      expect(sent.map(({ host }) => host)).toStrictEqual(["api.openai.com"]);
    });

    it("says a provider that didn't answer is unreachable, never refused", async () => {
      await connect().saveAiProviderKey({ provider: "openai", key: newKey() });
      nextAnswer = () => {
        throw new TypeError("Network connection lost.");
      };

      const response = await connect().modelFetch(
        modelRequest(openAiUrl),
        await grantFor({ provider: "openai", host: "api.openai.com" })
      );

      expect([response.status, refusalOf(response)]).toStrictEqual([
        502,
        "unreachable",
      ]);
    });
  });

  describe("a model request connect sends", () => {
    it.each([
      [
        "anthropic",
        "https://api.anthropic.com/v1/messages?beta=true",
        "x-api-key",
      ],
      ["openai", openAiUrl, "authorization"],
      [
        "mistral",
        "https://api.mistral.ai/v1/chat/completions",
        "authorization",
      ],
      [
        "openrouter",
        "https://openrouter.ai/api/v1/chat/completions",
        "authorization",
      ],
    ] as const)(
      "carries the %s key once, in its one header, with nothing else of core's",
      async (provider, url, header) => {
        const key = newKey();
        await connect().saveAiProviderKey({ provider, key });
        const placeholder: Record<string, string> =
          header === "x-api-key"
            ? { "x-api-key": aiCredentialPlaceholder }
            : { authorization: `Bearer ${aiCredentialPlaceholder}` };

        const response = await connect().modelFetch(
          modelRequest(url, {
            headers: {
              ...placeholder,
              "anthropic-version": "2023-06-01",
              cookie: "core=session",
              "x-stainless-os": "workerd",
              "x-request-id": "ledger-request-1",
            },
          }),
          await grantFor({ provider, host: new URL(url).hostname })
        );

        const [request] = sent;
        const headers = request?.headers ?? {};
        expect({
          status: response.status,
          holders: Object.entries(headers)
            .filter(([, value]) => value.includes(key))
            .map(([name]) => name),
          key: headers[header],
          // Nothing else of core's: no cookie, no SDK's own headers.
          sent: Object.keys(headers).toSorted(),
          // Nothing of the provider's answer but what core may read.
          answered: [...response.headers.keys()].toSorted(),
        }).toStrictEqual({
          status: 200,
          holders: [header],
          key: header === "x-api-key" ? key : `Bearer ${key}`,
          sent: [
            "anthropic-version",
            "content-type",
            header,
            "x-request-id",
          ].toSorted(),
          answered: ["content-type", "request-id"],
        });
        expect(JSON.stringify(request)).not.toContain(aiCredentialPlaceholder);
      }
    );

    it("sends Grasp's own key for a platform feature", async () => {
      const response = await connect().modelFetch(
        modelRequest(openAiUrl),
        await grantFor({
          provider: "openai",
          host: "api.openai.com",
          credential: "platform",
        })
      );

      expect(response.status).toBe(200);
      expect(sent[0]?.headers.authorization).toBe(`Bearer ${platformKey}`);
      await expect(connect().aiProviderRoutes()).resolves.toStrictEqual({
        organization: [],
        platform: ["openai"],
      });
    });
  });

  describe("an organization's own key", () => {
    it("is never answered back, only its mask, nor logged, whatever happens to it", async () => {
      const spies = [
        vi.spyOn(console, "log"),
        vi.spyOn(console, "info"),
        vi.spyOn(console, "warn"),
        vi.spyOn(console, "error"),
      ];
      const key = newKey();

      const saved = await connect().saveAiProviderKey({
        provider: "openai",
        key,
      });
      const listed = await connect().aiProviderKeys();
      await connect().modelFetch(
        modelRequest(openAiUrl),
        await grantFor({ provider: "openai", host: "api.openai.com" })
      );
      await connect().modelFetch(
        modelRequest("https://api.openai.com/v1/files"),
        await grantFor({ provider: "openai", host: "api.openai.com" })
      );
      const stored = await env.DB.prepare(
        "SELECT * FROM ai_provider_keys"
      ).all();

      expect(saved).toMatchObject({
        provider: "openai",
        mask: `${key.slice(0, 3)}…${key.slice(-4)}`,
        baseUrl: null,
      });
      expect(JSON.stringify([saved, listed, stored.results])).not.toContain(
        key
      );
      for (const spy of spies) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(key);
      }
    });

    it("goes only to the base URL it was saved with, and not once that base URL is changed in the database", async () => {
      const key = newKey();
      await connect().saveAiProviderKey({
        provider: "openai-compatible",
        key,
        baseUrl: "https://llm.acme-ai.test/v1/",
      });
      const grant = async () =>
        await grantFor({
          provider: "openai-compatible",
          host: "llm.acme-ai.test",
        });

      const sentThere = await connect().modelFetch(
        modelRequest("https://llm.acme-ai.test/v1/chat/completions"),
        await grant()
      );
      const otherPath = await connect().modelFetch(
        modelRequest("https://llm.acme-ai.test/v2/chat/completions"),
        await grant()
      );
      // Someone with the database moves the key's destination.
      await env.DB.prepare(
        "UPDATE ai_provider_keys SET base_url = 'https://attacker.example/v1'"
      ).run();
      const moved = await connect().modelFetch(
        modelRequest("https://attacker.example/v1/chat/completions"),
        await grantFor({
          provider: "openai-compatible",
          host: "attacker.example",
        })
      );

      expect([sentThere, otherPath, moved].map(refusalOf)).toStrictEqual([
        "sent",
        "path",
        "no_credential",
      ]);
      expect(sent.map(({ host, path }) => `${host}${path}`)).toStrictEqual([
        "llm.acme-ai.test/v1/chat/completions",
      ]);
    });

    it("refuses a custom endpoint on a private, internal, metadata or plain-HTTP address", async () => {
      const refusals = await Promise.all(
        [
          "http://llm.acme-ai.test/v1",
          "https://169.254.169.254/latest",
          "https://10.0.0.8/v1",
          "https://2130706433/v1",
          "https://localhost/v1",
          "https://printer.local/v1",
          "https://[fd00:ec2::254]/v1",
          "https://llm.acme-ai.test/v1?key=1",
        ].map(
          async (baseUrl) =>
            await outcome(
              connect().saveAiProviderKey({
                provider: "openai-compatible",
                key: newKey(),
                baseUrl,
              })
            )
        )
      );

      expect(new Set(refusals)).toStrictEqual(
        new Set(["ai_key.endpoint_refused"])
      );
      await expect(connect().aiProviderKeys()).resolves.toStrictEqual([]);
    });

    it("takes a private host on-prem only where the deployment names it, never a metadata address", async () => {
      const onPrem = connect({
        RUNTIME_PROFILE: "workerd",
        AI_PRIVATE_HOSTS: "models.acme.lan, 169.254.169.254",
      });

      const named = await outcome(
        onPrem.saveAiProviderKey({
          provider: "openai-compatible",
          key: newKey(),
          baseUrl: "http://models.acme.lan:8000/v1",
        })
      );
      const metadata = await outcome(
        onPrem.saveAiProviderKey({
          provider: "openai-compatible",
          key: newKey(),
          baseUrl: "http://169.254.169.254/v1",
        })
      );
      const hosted = await outcome(
        connect({ AI_PRIVATE_HOSTS: "models.acme.lan" }).saveAiProviderKey({
          provider: "openai-compatible",
          key: newKey(),
          baseUrl: "http://models.acme.lan:8000/v1",
        })
      );

      expect({ named, metadata, hosted }).toStrictEqual({
        named: "ok",
        metadata: "ai_key.endpoint_refused",
        hosted: "ai_key.endpoint_refused",
      });
    });

    it("is replaced and removed whole", async () => {
      const first = newKey();
      const second = newKey();
      await connect().saveAiProviderKey({ provider: "openai", key: first });
      await connect().saveAiProviderKey({ provider: "openai", key: second });
      const grant = async () =>
        await grantFor({ provider: "openai", host: "api.openai.com" });

      await connect().modelFetch(modelRequest(openAiUrl), await grant());
      const removed = await connect().removeAiProviderKey("openai");
      const after = await connect().modelFetch(
        modelRequest(openAiUrl),
        await grant()
      );

      expect(sent.map(({ headers }) => headers.authorization)).toStrictEqual([
        `Bearer ${second}`,
      ]);
      expect([removed, refusalOf(after)]).toStrictEqual([
        true,
        "no_credential",
      ]);
      await expect(
        connect().removeAiProviderKey("openai")
      ).resolves.toBeFalsy();
    });

    it("survives a rotation of the token key: sealed again by the clock", async () => {
      const key = newKey();
      await connect().saveAiProviderKey({
        provider: "openai",
        key,
      });
      const newTokenKey = btoa("another-token-key-of-32-bytes!!!");
      const rotating = {
        ...env,
        OPENAI_API_KEY: platformKey,
        TOKEN_ENCRYPTION_KEY: newTokenKey,
        TOKEN_ENCRYPTION_KEY_PREVIOUS: env.TOKEN_ENCRYPTION_KEY,
      };

      await resealAiProviderKeys(rotating);
      const rotated = connectWith({ TOKEN_ENCRYPTION_KEY: newTokenKey });
      const response = await rotated.modelFetch(
        modelRequest(openAiUrl),
        await grantFor({ provider: "openai", host: "api.openai.com" })
      );

      expect(refusalOf(response)).toBe("sent");
      expect(sent[0]?.headers.authorization).toBe(`Bearer ${key}`);
    });
  });

  describe("where a custom endpoint may point", () => {
    const hosted: EndpointPolicy = { onPrem: false, privateHosts: [] };

    it.each([
      ["https://169.254.169.254/latest/meta-data", "metadata_address"],
      ["https://metadata.google.internal/", "metadata_address"],
      ["https://100.100.100.200/", "metadata_address"],
      ["https://127.0.0.1/v1", "private_address"],
      ["https://0x7f.1/v1", "private_address"],
      ["https://172.20.0.1/v1", "private_address"],
      ["https://192.168.1.1/v1", "private_address"],
      ["https://100.64.0.1/v1", "private_address"],
      ["https://[::ffff:169.254.169.254]/v1", "private_address"],
      ["https://models/v1", "private_address"],
      ["ftp://models.example.com/v1", "scheme"],
      ["not a url", "invalid_url"],
    ])("refuses %s (%s)", (url, refused) => {
      const checked = checkEndpoint(url, hosted);
      expect("refused" in checked ? checked.refused : "ok").toBe(refused);
    });

    it("takes a public HTTPS endpoint", () => {
      expect(
        "refused" in
          checkEndpoint("https://acme.openai.azure.com/openai/v1", hosted)
      ).toBeFalsy();
    });
  });
});
