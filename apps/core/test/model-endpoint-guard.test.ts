import {
  processingWords,
  residencyAllows,
  residencyCatalog,
  residencyEntryOf,
} from "@grasp-os/shared/model-residency";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { checkEndpoint } from "../src/model-endpoint-guard.ts";
import type { EndpointPolicy } from "../src/model-endpoint-guard.ts";
import { pinnedFetch } from "../src/model-transport-direct.ts";

// Pure logic at the edge of the model gateway: where a custom endpoint may
// point (server-side request forgery), the residency catalog's verdict on
// a route by the host it actually sends to, and the one fetch a direct
// route sends through. The ways each can fail come first.

const hosted: EndpointPolicy = { onPrem: false, privateHosts: [] };
const onPrem: EndpointPolicy = {
  onPrem: true,
  privateHosts: ["models.acme.lan", "10.0.0.8"],
};

/** Why `url` is refused under `policy`, or `ok`. */
const verdict = (url: string, policy: EndpointPolicy = hosted): string => {
  const checked = checkEndpoint(url, policy);
  return "refused" in checked ? checked.refused : "ok";
};

describe("a custom endpoint", () => {
  it.each([
    ["https://169.254.169.254/latest/meta-data", "metadata_address"],
    ["https://[fd00:ec2::254]/", "metadata_address"],
    ["https://metadata.google.internal/", "metadata_address"],
    ["https://100.100.100.200/", "metadata_address"],
    ["https://localhost/v1", "private_address"],
    ["https://127.0.0.1/v1", "private_address"],
    // The URL parser reads these as 127.0.0.1 too.
    ["https://2130706433/v1", "private_address"],
    ["https://0x7f.1/v1", "private_address"],
    ["https://10.1.2.3/v1", "private_address"],
    ["https://172.20.0.1/v1", "private_address"],
    ["https://192.168.1.1/v1", "private_address"],
    ["https://100.64.0.1/v1", "private_address"],
    ["https://[::1]/v1", "private_address"],
    ["https://[::ffff:169.254.169.254]/v1", "private_address"],
    ["https://models/v1", "private_address"],
    ["https://models.internal/v1", "private_address"],
    ["https://printer.local/v1", "private_address"],
    ["http://models.example.com/v1", "scheme"],
    ["ftp://models.example.com/v1", "scheme"],
    ["https://models.example.com:8443/v1", "port"],
    // Credentials in the URL, put together so no scanner takes them for real ones.
    [
      `https://${["user", "pass"].join(":")}@models.example.com/v1`,
      "credentials",
    ],
    ["not a url", "invalid_url"],
  ])("refuses %s on a hosted deployment (%s)", (url, refused) => {
    expect(verdict(url)).toBe(refused);
  });

  it("takes a public HTTPS endpoint", () => {
    expect(verdict("https://acme.openai.azure.com/openai/v1")).toBe("ok");
  });

  it("takes a private host on-prem only where the deployment named it, and never a metadata address", () => {
    expect({
      named: verdict("http://models.acme.lan:8000/v1", onPrem),
      namedIp: verdict("http://10.0.0.8:8000/v1", onPrem),
      unnamed: verdict("http://10.0.0.9:8000/v1", onPrem),
      hosted: verdict("http://models.acme.lan:8000/v1", {
        onPrem: false,
        privateHosts: ["models.acme.lan"],
      }),
      metadata: verdict("http://169.254.169.254/", {
        onPrem: true,
        privateHosts: ["169.254.169.254"],
      }),
    }).toStrictEqual({
      named: "ok",
      namedIp: "ok",
      unnamed: "private_address",
      hosted: "private_address",
      metadata: "metadata_address",
    });
  });
});

describe("a direct route's fetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends nothing to any host but its route's", async () => {
    const sent = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));
    const routeFetch = pinnedFetch("api.anthropic.com", hosted);

    await expect(
      routeFetch("https://api.anthropic.com.evil.example/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "test-key" },
      })
    ).rejects.toThrow("isn't its route's");
    expect(sent).not.toHaveBeenCalled();
  });

  it("follows no redirect, which could carry its key or its data elsewhere", async () => {
    const sent = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: "https://elsewhere.example/v1/messages" },
      })
    );
    const routeFetch = pinnedFetch("api.anthropic.com", hosted);

    const answered = await routeFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
    });

    expect({
      status: answered.status,
      sent: sent.mock.calls.length,
    }).toStrictEqual({
      status: 502,
      sent: 1,
    });
    expect(sent.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });
});

describe("the residency catalog", () => {
  it("places a route by the host it sends to, never by its setting: Bedrock outside Frankfurt is no EU route", () => {
    const frankfurt = residencyEntryOf({
      transport: "direct",
      provider: "bedrock-eu",
      host: "bedrock-mantle.eu-central-1.api.aws",
    });
    const virginia = residencyEntryOf({
      transport: "direct",
      provider: "bedrock-eu",
      host: "bedrock-mantle.us-east-1.api.aws",
    });

    expect({
      frankfurt: residencyAllows("eu", frankfurt, false),
      virginia: residencyAllows("eu", virginia, false),
      virginiaGlobal: residencyAllows("global", virginia, false),
    }).toStrictEqual({
      frankfurt: true,
      virginia: false,
      virginiaGlobal: true,
    });
  });

  it("documents every EU route it allows, and takes an attestation only where the host can't say", () => {
    const eu = residencyCatalog.filter(({ eu: basis }) => basis !== "no");

    expect(
      eu.map(({ id, eu: basis, basis: links }) => ({
        id,
        basis,
        documented: basis === "attested" || links.length > 0,
      }))
    ).toStrictEqual([
      { id: "direct/bedrock-eu", basis: "documented", documented: true },
      {
        id: "openai-compatible/azure-openai",
        basis: "attested",
        documented: true,
      },
      {
        id: "openai-compatible/private-network",
        basis: "attested",
        documented: true,
      },
    ]);
  });

  it("says where AI runs in plain words, from the routes in force", () => {
    const bedrock = residencyCatalog.filter(
      ({ id }) => id === "direct/bedrock-eu"
    );
    const gateway = residencyCatalog.filter(
      ({ id }) => id === "cloudflare-ai-gateway/workers-ai"
    );

    expect({
      eu: processingWords(bedrock, "eu"),
      global: processingWords(gateway, "global"),
      refused: processingWords(gateway, "eu"),
      none: processingWords([], "eu"),
    }).toStrictEqual({
      eu: "AI runs in the EU (Amazon Bedrock in the EU (Frankfurt, EU inference profile)).",
      global:
        "AI runs outside the EU (Cloudflare Workers AI, on Cloudflare's global network).",
      refused:
        "AI can't run: no allowed model is reached in the EU (Cloudflare Workers AI, on Cloudflare's global network).",
      none: "AI isn't set up: no allowed model can be reached.",
    });
  });
});
