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
 * its row was tampered with; a realtime socket (Grasp's live listening)
 * opened without a platform grant, to another path, or on an
 * organization's key, or left open at one end. Then what it is for.
 */
import {
  aiCredentialPlaceholder,
  aiGrantHeader,
  aiKeyErrors,
  aiRefusedHeader,
} from "@grasp-os/shared/ai-providers";
import { auditEventSchema } from "@grasp-os/shared/audit";
import { signModelGrant } from "@grasp-os/shared/capability";
import type { ModelGrantScope } from "@grasp-os/shared/capability";
import { sha256Hex } from "@grasp-os/shared/encoding";
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

/** The organization's admin core names as changing a key. */
const byAdmin = { type: "person", userId: "admin-1" } as const;

/** The body a model request carries unless a test says otherwise. */
const modelBody = JSON.stringify({ model: "gpt-5.4" });

/** The grant core signs for one request, made with connect's key. */
const grantFor = async (
  scope: Partial<ModelGrantScope> & Pick<ModelGrantScope, "provider" | "host">,
  key: string = env.CAPABILITY_SIGNING_KEY
): Promise<string> =>
  await signModelGrant(key, {
    credential: "organization",
    request: crypto.randomUUID(),
    notAfter: Date.now() + 60_000,
    body: await sha256Hex(modelBody),
    ...scope,
  });

/** A model request as pi's adapter makes it, with the placeholder. */
const modelRequest = (
  url: string,
  {
    method = "POST",
    headers = { authorization: `Bearer ${aiCredentialPlaceholder}` },
    body = modelBody,
  }: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Request =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "GET" ? null : body,
  });

/** The `store` a sent JSON body asks for, if it names one. */
const storeOf = (body: string): unknown => {
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === "object" && parsed !== null && "store" in parsed
    ? parsed.store
    : undefined;
};

/** The events connect's audit outbox holds, oldest first. */
const outboxed = async () => {
  const { results } = await env.DB.prepare(
    "SELECT event FROM audit_outbox ORDER BY rowid"
  ).all<{ event: string }>();
  return results.map(({ event }) => auditEventSchema.parse(JSON.parse(event)));
};

/**
 * Makes the database refuse every write of a key with an error that
 * quotes what was written, as a database's errors quote a query's
 * values, behind `marker`; until the returned function puts it right.
 */
const quotingRefusal = async (marker: string): Promise<() => Promise<void>> => {
  await env.DB.prepare(
    `CREATE TRIGGER quoting_refusal BEFORE INSERT ON ai_provider_keys BEGIN SELECT RAISE(ABORT, '${marker}' || NEW.sealed || ' ' || NEW.mask); END`
  ).run();
  return async () => {
    await env.DB.prepare("DROP TRIGGER quoting_refusal").run();
  };
};

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
    await env.DB.prepare("DELETE FROM audit_outbox").run();
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
      await connect().saveAiProviderKey(
        { provider: "openai", key: newKey() },
        byAdmin
      );
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
            body: await sha256Hex(modelBody),
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
      await connect().saveAiProviderKey(
        { provider: "openai", key: newKey() },
        byAdmin
      );
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
      await connect().saveAiProviderKey(
        { provider: "openai", key: newKey() },
        byAdmin
      );
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
      await connect().saveAiProviderKey(
        { provider: "openai", key: newKey() },
        byAdmin
      );
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
      await connect().saveAiProviderKey(
        { provider: "openai", key: newKey() },
        byAdmin
      );
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

    it("refuses a body other than the one its grant was signed for", async () => {
      await connect().saveAiProviderKey(
        { provider: "openai", key: newKey() },
        byAdmin
      );
      const grant = await grantFor({
        provider: "openai",
        host: "api.openai.com",
      });

      const response = await connect().modelFetch(
        modelRequest(openAiUrl, {
          body: JSON.stringify({ model: "gpt-5.4", input: "Something else." }),
        }),
        grant
      );

      expect(refusalOf(response)).toBe("body");
      expect(sent).toStrictEqual([]);
    });

    it("refuses a request on Grasp's key that builds on a response or conversation OpenAI kept", async () => {
      const refusals = await Promise.all(
        [
          { model: "gpt-5.4", previous_response_id: "resp_1" },
          { model: "gpt-5.4", conversation: "conv_1" },
          ["not", "an", "object"],
        ].map(async (asked) => {
          const body = JSON.stringify(asked);
          return refusalOf(
            await connect().modelFetch(
              modelRequest(openAiUrl, { body }),
              await grantFor({
                provider: "openai",
                host: "api.openai.com",
                credential: "platform",
                body: await sha256Hex(body),
              })
            )
          );
        })
      );

      expect(refusals).toStrictEqual(["stored", "stored", "stored"]);
      expect(sent).toStrictEqual([]);
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
        await connect().saveAiProviderKey({ provider, key }, byAdmin);
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

    it("sends a request on Grasp's key to OpenAI with store off, whatever core asked, and the organization's as it came", async () => {
      const body = JSON.stringify({ model: "gpt-5.4", store: true });
      await connect().saveAiProviderKey(
        { provider: "openai", key: newKey() },
        byAdmin
      );

      await Promise.all(
        (["platform", "organization"] as const).map(
          async (credential) =>
            await connect().modelFetch(
              modelRequest(openAiUrl, { body }),
              await grantFor({
                provider: "openai",
                host: "api.openai.com",
                credential,
                body: await sha256Hex(body),
              })
            )
        )
      );

      const stores = Object.fromEntries(
        sent.map(({ headers, body: carried }) => [
          headers.authorization === `Bearer ${platformKey}`
            ? "platform"
            : "organization",
          storeOf(carried),
        ])
      );
      expect(stores).toStrictEqual({ platform: false, organization: true });
    });
  });

  describe("Grasp's own speech and transcription", () => {
    it("sends a line to say and a recording to write down, and nothing else of OpenAI's audio", async () => {
      const grant = async () =>
        await grantFor({
          provider: "openai",
          host: "api.openai.com",
          credential: "platform",
        });
      const outcomes = {
        speech: refusalOf(
          await connect().modelFetch(
            modelRequest("https://api.openai.com/v1/audio/speech"),
            await grant()
          )
        ),
        transcription: refusalOf(
          await connect().modelFetch(
            modelRequest("https://api.openai.com/v1/audio/transcriptions"),
            await grant()
          )
        ),
        translation: refusalOf(
          await connect().modelFetch(
            modelRequest("https://api.openai.com/v1/audio/translations"),
            await grant()
          )
        ),
        voices: refusalOf(
          await connect().modelFetch(
            modelRequest("https://api.openai.com/v1/audio/voice_consents"),
            await grant()
          )
        ),
      };

      expect({
        outcomes,
        paths: sent.map(({ path }) => path),
      }).toStrictEqual({
        outcomes: {
          speech: "sent",
          transcription: "sent",
          translation: "path",
          voices: "path",
        },
        paths: ["/v1/audio/speech", "/v1/audio/transcriptions"],
      });
    });
  });

  describe("a realtime socket, for Grasp's live listening", () => {
    const realtimeUrl =
      "https://api.openai.com/v1/realtime?intent=transcription";

    /** OpenAI's end of each socket connect opens: what it got, and how it closed. */
    const upstreams: {
      socket: WebSocket;
      got: string[];
      closed: Promise<number>;
    }[] = [];

    beforeEach(() => {
      upstreams.length = 0;
      nextAnswer = () => {
        const { 0: client, 1: server } = new WebSocketPair();
        server.accept();
        const got: string[] = [];
        const closed = Promise.withResolvers<number>();
        server.addEventListener("message", (event) => {
          got.push(String(event.data));
        });
        server.addEventListener("close", (event) => {
          closed.resolve(event.code);
        });
        upstreams.push({ socket: server, got, closed: closed.promise });
        return new Response(null, { status: 101, webSocket: client });
      };
    });

    /** The upgrade core sends connect: its grant, and the placeholder. */
    const upgrade = async (
      url = realtimeUrl,
      {
        grant,
        headers = { authorization: `Bearer ${aiCredentialPlaceholder}` },
      }: { grant?: string | null; headers?: Record<string, string> } = {}
    ): Promise<Request> => {
      const granted =
        grant === undefined
          ? await grantFor({
              provider: "openai",
              host: new URL(url).hostname,
              credential: "platform",
            })
          : grant;
      return new Request(url, {
        headers: {
          upgrade: "websocket",
          ...(granted === null ? {} : { [aiGrantHeader]: granted }),
          ...headers,
        },
      });
    };

    it("refuses a socket without a platform grant, to any other path or host, without the placeholder, or without Grasp's key", async () => {
      const organizationGrant = await grantFor({
        provider: "openai",
        host: "api.openai.com",
      });
      const elsewhereGrant = await grantFor({
        provider: "openai",
        host: "evil.example",
        credential: "platform",
      });
      const refusals = {
        forged: refusalOf(
          await connect().fetch(await upgrade(realtimeUrl, { grant: "forged" }))
        ),
        organization: refusalOf(
          await connect().fetch(
            await upgrade(realtimeUrl, { grant: organizationGrant })
          )
        ),
        responses: refusalOf(
          await connect().fetch(
            await upgrade("https://api.openai.com/v1/responses")
          )
        ),
        conversation: refusalOf(
          await connect().fetch(
            await upgrade(
              "https://api.openai.com/v1/realtime?model=gpt-realtime"
            )
          )
        ),
        elsewhere: refusalOf(
          await connect().fetch(
            await upgrade(
              "https://evil.example/v1/realtime?intent=transcription",
              {
                grant: elsewhereGrant,
              }
            )
          )
        ),
        ownKey: refusalOf(
          await connect().fetch(
            await upgrade(realtimeUrl, {
              headers: { authorization: "Bearer sk-core-of-its-own" },
            })
          )
        ),
        noUpgrade: refusalOf(
          await connect().fetch(
            new Request(realtimeUrl, {
              headers: {
                [aiGrantHeader]: await grantFor({
                  provider: "openai",
                  host: "api.openai.com",
                  credential: "platform",
                }),
                authorization: `Bearer ${aiCredentialPlaceholder}`,
              },
            })
          )
        ),
        noPlatformKey: refusalOf(
          await connect({ OPENAI_API_KEY: "" }).fetch(await upgrade())
        ),
      };

      expect(refusals).toStrictEqual({
        forged: "grant",
        organization: "no_credential",
        responses: "path",
        conversation: "path",
        elsewhere: "endpoint",
        ownKey: "credential_header",
        noUpgrade: "method",
        noPlatformKey: "no_credential",
      });
      expect(sent).toStrictEqual([]);
    });

    it("opens OpenAI's socket with Grasp's key alone, and passes each message on both ways", async () => {
      const response = await connect().fetch(await upgrade());
      const core = response.webSocket;
      core?.accept();
      const heard = Promise.withResolvers<string>();
      core?.addEventListener("message", (event) => {
        heard.resolve(String(event.data));
      });

      core?.send('{"type":"session.update"}');
      const [upstream] = upstreams;
      await vi.waitFor(() => {
        expect(upstream?.got).toStrictEqual(['{"type":"session.update"}']);
      });
      upstream?.socket.send('{"type":"session.updated"}');

      const [request] = sent;
      expect({
        status: response.status,
        answered: await heard.promise,
        path: request?.path,
        // Grasp's key in its one header; never the grant or the placeholder.
        headers: Object.keys(request?.headers ?? {}).toSorted(),
        key: request?.headers.authorization,
      }).toStrictEqual({
        status: 101,
        answered: '{"type":"session.updated"}',
        path: "/v1/realtime?intent=transcription",
        headers: ["authorization", "upgrade"],
        key: `Bearer ${platformKey}`,
      });
      core?.close(1000, "Done");
      await expect(upstream?.closed).resolves.toBe(1000);
    });

    it("closes core's end when OpenAI's closes, and says a provider that won't upgrade refused", async () => {
      const response = await connect().fetch(await upgrade());
      const core = response.webSocket;
      core?.accept();
      const closed = Promise.withResolvers<number>();
      core?.addEventListener("close", (event) => {
        closed.resolve(event.code);
      });
      upstreams[0]?.socket.close(1011, "Gone");
      nextAnswer = () => Response.json({ error: "no" }, { status: 401 });
      const refused = await connect().fetch(await upgrade());

      expect({
        closed: await closed.promise,
        refused: refusalOf(refused),
      }).toStrictEqual({ closed: 1011, refused: "upgrade" });
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

      const saved = await connect().saveAiProviderKey(
        {
          provider: "openai",
          key,
        },
        byAdmin
      );
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
        mask: `…${key.slice(-4)}`,
        baseUrl: null,
      });
      expect(JSON.stringify([saved, listed, stored.results])).not.toContain(
        key
      );
      for (const spy of spies) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(key);
      }
    });

    it("is recorded in the admin's name in the same write as each save and removal, never with the key", async () => {
      const key = newKey();

      await connect().saveAiProviderKey(
        {
          provider: "openai-compatible",
          key,
          baseUrl: "https://llm.acme-ai.test/v1",
        },
        byAdmin
      );
      await connect().saveAiProviderKey(
        {
          provider: "openai-compatible",
          key: newKey(),
          baseUrl: "https://llm.acme-ai.test/v1",
        },
        byAdmin
      );
      await connect().removeAiProviderKey("openai-compatible", byAdmin);
      await connect().removeAiProviderKey("openai-compatible", byAdmin);
      const events = await outboxed();

      expect(
        events.map(({ actor, action, target, detail }) => ({
          actor,
          action,
          target,
          detail,
        }))
      ).toStrictEqual([
        {
          actor: byAdmin,
          action: "ai_provider.added",
          target: { type: "ai_provider", id: "openai-compatible" },
          detail: {
            provider: "openai-compatible",
            endpointHost: "llm.acme-ai.test",
          },
        },
        {
          actor: byAdmin,
          action: "ai_provider.replaced",
          target: { type: "ai_provider", id: "openai-compatible" },
          detail: {
            provider: "openai-compatible",
            endpointHost: "llm.acme-ai.test",
          },
        },
        {
          actor: byAdmin,
          action: "ai_provider.removed",
          target: { type: "ai_provider", id: "openai-compatible" },
          detail: { provider: "openai-compatible" },
        },
      ]);
      expect(JSON.stringify(events)).not.toContain(key);
    });

    it("is changed only in a person's name, never staff's, code's or no one's", async () => {
      const changers = [
        undefined,
        { type: "staff", userId: "staff-1" },
        { type: "system" },
      ];

      const refusals = await Promise.all(
        changers.map(
          async (by) =>
            await outcome(
              connect().saveAiProviderKey(
                { provider: "openai", key: newKey() },
                by
              )
            )
        )
      );

      expect(new Set(refusals)).toStrictEqual(new Set(["ai_key.invalid"]));
      await expect(connect().aiProviderKeys()).resolves.toStrictEqual([]);
      await expect(outboxed()).resolves.toStrictEqual([]);
    });

    it("fails a save the database refuses as ai_key.failed, quoting nothing of what was written, and keeps no event", async () => {
      const spies = [
        vi.spyOn(console, "log"),
        vi.spyOn(console, "warn"),
        vi.spyOn(console, "error"),
      ];
      const key = newKey();
      const marker = "QUOTED:";
      const restore = await quotingRefusal(marker);
      let failure: unknown;
      try {
        await connect().saveAiProviderKey({ provider: "openai", key }, byAdmin);
      } catch (error) {
        failure = error;
      } finally {
        await restore();
      }

      expect(aiKeyErrors.codeOf(failure)).toBe("ai_key.failed");
      const everywhere = JSON.stringify([
        String(failure),
        failure instanceof Error ? failure.message : null,
        spies.map((spy) => spy.mock.calls),
      ]);
      expect(everywhere).not.toContain(marker);
      expect(everywhere).not.toContain(key.slice(-4));
      await expect(outboxed()).resolves.toStrictEqual([]);
    });

    it("goes only to the base URL it was saved with, and not once that base URL is changed in the database", async () => {
      const key = newKey();
      await connect().saveAiProviderKey(
        {
          provider: "openai-compatible",
          key,
          baseUrl: "https://llm.acme-ai.test/v1/",
        },
        byAdmin
      );
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
              connect().saveAiProviderKey(
                {
                  provider: "openai-compatible",
                  key: newKey(),
                  baseUrl,
                },
                byAdmin
              )
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
        onPrem.saveAiProviderKey(
          {
            provider: "openai-compatible",
            key: newKey(),
            baseUrl: "http://models.acme.lan:8000/v1",
          },
          byAdmin
        )
      );
      const metadata = await outcome(
        onPrem.saveAiProviderKey(
          {
            provider: "openai-compatible",
            key: newKey(),
            baseUrl: "http://169.254.169.254/v1",
          },
          byAdmin
        )
      );
      const hosted = await outcome(
        connect({ AI_PRIVATE_HOSTS: "models.acme.lan" }).saveAiProviderKey(
          {
            provider: "openai-compatible",
            key: newKey(),
            baseUrl: "http://models.acme.lan:8000/v1",
          },
          byAdmin
        )
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
      await connect().saveAiProviderKey(
        { provider: "openai", key: first },
        byAdmin
      );
      await connect().saveAiProviderKey(
        { provider: "openai", key: second },
        byAdmin
      );
      const grant = async () =>
        await grantFor({ provider: "openai", host: "api.openai.com" });

      await connect().modelFetch(modelRequest(openAiUrl), await grant());
      const removed = await connect().removeAiProviderKey("openai", byAdmin);
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
        connect().removeAiProviderKey("openai", byAdmin)
      ).resolves.toBeFalsy();
    });

    it("survives a rotation of the token key: sealed again by the clock", async () => {
      const key = newKey();
      await connect().saveAiProviderKey(
        {
          provider: "openai",
          key,
        },
        byAdmin
      );
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
      ["https://127.0.0.1.nip.io/v1", "address_in_name"],
      ["https://7f000001.nip.io/v1", "address_in_name"],
      ["https://10-0-0-8.sslip.io/v1", "address_in_name"],
      ["https://169-254-169-254.attacker.example/v1", "address_in_name"],
      ["https://llm.10.0.0.8.attacker.example/v1", "address_in_name"],
      ["ftp://models.example.com/v1", "scheme"],
      ["not a url", "invalid_url"],
    ])("refuses %s (%s)", (url, refused) => {
      const checked = checkEndpoint(url, hosted);
      expect("refused" in checked ? checked.refused : "ok").toBe(refused);
    });

    it("refuses a name carrying an address on-prem too, unless the deployment lists it exactly", () => {
      const onPrem: EndpointPolicy = {
        onPrem: true,
        privateHosts: ["models.acme.lan", "10.0.0.8.nip.io"],
      };
      const outcomeOf = (url: string) => {
        const checked = checkEndpoint(url, onPrem);
        return "refused" in checked ? checked.refused : "ok";
      };

      expect({
        unlisted: outcomeOf("http://127.0.0.1.nip.io:8000/v1"),
        listed: outcomeOf("http://10.0.0.8.nip.io:8000/v1"),
        named: outcomeOf("http://models.acme.lan:8000/v1"),
        unnamedPrivate: outcomeOf("http://10.0.0.9:8000/v1"),
      }).toStrictEqual({
        unlisted: "address_in_name",
        listed: "ok",
        named: "ok",
        unnamedPrivate: "private_address",
      });
    });

    it("takes a public HTTPS endpoint", () => {
      expect(
        "refused" in
          checkEndpoint("https://acme.openai.azure.com/openai/v1", hosted)
      ).toBeFalsy();
    });
  });
});
