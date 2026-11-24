import { channelErrors, channelKeyLimits } from "@grasp-os/shared/channel-keys";
import { exports } from "cloudflare:workers";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { botFrameworkKeysFake } from "./bot-framework-keys-fake.ts";

// A chat platform's signing keys through connect (src/channel-keys.ts),
// from its threat model: being sent to another key set, by the metadata or
// a redirect; credentials leaving; answers too large; more passed on than
// a check needs; and a failure passed on as no keys. Microsoft's Bot
// Framework is a fake of login.botframework.com (bot-framework-keys-fake.ts).

const fakeInternet = () => {
  const microsoft = botFrameworkKeysFake();
  const elsewhere: { url: string; headers: Headers }[] = [];
  const sent: Request[] = [];
  beforeEach(() => {
    microsoft.reset();
    elsewhere.length = 0;
    sent.length = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      sent.push(request);
      if (new URL(request.url).origin === microsoft.origin) {
        return await Promise.resolve(microsoft.answer(request));
      }
      elsewhere.push({ url: request.url, headers: request.headers });
      return await Promise.resolve(Response.json({ keys: [] }));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  return { microsoft, elsewhere, sent };
};

const { microsoft, elsewhere, sent } = fakeInternet();

const connect = exports.default;

const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return channelErrors.codeOf(error) ?? String(error);
  }
};

/** A public RSA key as Microsoft publishes one, with its extra fields. */
const publishedKey = async (kid: string, endorsements: string[]) => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  if (!("publicKey" in pair)) {
    throw new TypeError("Expected a key pair");
  }
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (jwk instanceof ArrayBuffer) {
    throw new TypeError("Expected a JWK");
  }
  return {
    kty: "RSA",
    use: "sig",
    kid,
    x5t: kid,
    n: jwk.n,
    e: jwk.e,
    x5c: ["MIIDBTCCAe2gAwIBAgIQ"],
    endorsements,
    issuer: "https://api.botframework.com",
  };
};

type PublishedKey = Awaited<ReturnType<typeof publishedKey>>;

/** The keys the file's tests publish, made once before them. */
const publishedKeys = () => {
  const made = new Map<string, PublishedKey>();
  beforeAll(async () => {
    made.set("teams", await publishedKey("teams-key", ["msteams", "webchat"]));
    made.set("other", await publishedKey("other-key", ["skype"]));
  });
  return (name: "teams" | "other"): PublishedKey => {
    const key = made.get(name);
    if (key === undefined) {
      throw new TypeError("Keys are made before the tests");
    }
    return key;
  };
};

const published = publishedKeys();

describe("what connect reads", () => {
  it("refuses a platform it doesn't fetch keys for, asking nothing", async () => {
    await expect(outcome(connect.channelSigningKeys("slack"))).resolves.toBe(
      "channel.invalid"
    );
    await expect(
      outcome(connect.channelSigningKeys({ teams: true }))
    ).resolves.toBe("channel.invalid");
    expect(sent).toHaveLength(0);
  });

  it("asks only the metadata, then the key set it names, without credentials or redirects", async () => {
    microsoft.setKeys([published("teams")]);
    await connect.channelSigningKeys("teams");
    expect(microsoft.asked).toStrictEqual([
      { method: "GET", path: microsoft.metadataPath, redirect: "manual" },
      { method: "GET", path: microsoft.keysPath, redirect: "manual" },
    ]);
    for (const request of sent) {
      expect([...request.headers.keys()]).toStrictEqual(["accept"]);
    }
  });
});

describe("where the key set may be", () => {
  const refusedUris = [
    "http://login.botframework.com/v1/.well-known/keys",
    "https://login.botframework.com:8443/v1/.well-known/keys",
    // Credentials in the URL, put in as a URL takes them.
    Object.assign(
      new URL("https://login.botframework.com/v1/.well-known/keys"),
      {
        username: "someone",
      }
    ).href,
    "https://attacker.test/keys",
    "https://login.botframework.com.attacker.test/keys",
    "not a url",
  ];

  it.each(refusedUris)(
    "refuses a key set at %s, never asking it",
    async (uri) => {
      microsoft.setKeys([published("teams")]);
      microsoft.setJwksUri(uri);
      await expect(outcome(connect.channelSigningKeys("teams"))).resolves.toBe(
        "channel.keys_unavailable"
      );
      expect(elsewhere).toHaveLength(0);
      expect(microsoft.asked.map(({ path }) => path)).toStrictEqual([
        microsoft.metadataPath,
      ]);
    }
  );

  it.each(["metadata", "key set"])(
    "refuses a redirect from the %s, following none",
    async (which) => {
      microsoft.setKeys([published("teams")]);
      microsoft.override(
        which === "metadata" ? microsoft.metadataPath : microsoft.keysPath,
        () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://attacker.test/keys" },
          })
      );
      await expect(outcome(connect.channelSigningKeys("teams"))).resolves.toBe(
        "channel.keys_unavailable"
      );
      expect(elsewhere).toHaveLength(0);
    }
  );
});

describe("a failure is never no keys", () => {
  const failures: Record<string, () => Response> = {
    "a 500": () => new Response("Down", { status: 500 }),
    "a 404": () => new Response("Not found", { status: 404 }),
    "text that isn't JSON": () => new Response("<html>"),
    "JSON that isn't the shape": () => Response.json({ keys: "none" }),
    "an answer past the limit": () =>
      new Response("x".repeat(channelKeyLimits.answerBytes + 1)),
  };
  const cases = Object.entries(failures).flatMap(([what, answer]) =>
    (["metadata", "key set"] as const).map((which) => ({ what, answer, which }))
  );

  it.each(cases)(
    "is keys_unavailable for $what from the $which",
    async ({ answer, which }) => {
      microsoft.setKeys([published("teams")]);
      microsoft.override(
        which === "metadata" ? microsoft.metadataPath : microsoft.keysPath,
        answer
      );
      await expect(outcome(connect.channelSigningKeys("teams"))).resolves.toBe(
        "channel.keys_unavailable"
      );
    }
  );

  it("is keys_unavailable when Microsoft can't be reached", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError("reset"));
    await expect(outcome(connect.channelSigningKeys("teams"))).resolves.toBe(
      "channel.keys_unavailable"
    );
  });
});

describe("what is passed on", () => {
  it("passes on only an RSA key's id, modulus, exponent and endorsements", async () => {
    const teamsKey = published("teams");
    const otherKey = published("other");
    microsoft.setKeys([
      teamsKey,
      otherKey,
      { kty: "EC", kid: "ec-key", crv: "P-256", x: "AAAA", y: "AAAA" },
      { kty: "RSA", kid: "short", n: "AQAB", e: "AQAB" },
      { kty: "RSA", kid: "", n: teamsKey.n, e: teamsKey.e },
    ]);
    await expect(connect.channelSigningKeys("teams")).resolves.toStrictEqual({
      keys: [
        {
          kid: "teams-key",
          kty: "RSA",
          n: teamsKey.n,
          e: teamsKey.e,
          endorsements: ["msteams", "webchat"],
        },
        {
          kid: "other-key",
          kty: "RSA",
          n: otherKey.n,
          e: otherKey.e,
          endorsements: ["skype"],
        },
      ],
    });
  });

  it("passes on a key without endorsements as endorsed for nothing", async () => {
    const { endorsements: _, ...bare } = published("teams");
    microsoft.setKeys([bare]);
    const { keys } = await connect.channelSigningKeys("teams");
    expect(keys.map(({ endorsements }) => endorsements)).toStrictEqual([[]]);
  });

  it(`passes on at most ${channelKeyLimits.keys} keys`, async () => {
    microsoft.setKeys(
      Array.from({ length: channelKeyLimits.keys + 5 }, (_, index) => ({
        ...published("teams"),
        kid: `key-${index}`,
      }))
    );
    const { keys } = await connect.channelSigningKeys("teams");
    expect(keys).toHaveLength(channelKeyLimits.keys);
  });
});
