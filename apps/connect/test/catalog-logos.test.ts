import { catalogLogoUrl } from "@grasp-os/shared/connect";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { catalogLogo, forgetCatalogLogos, maxLogoBytes } from "../src/logos.ts";
import { fakeComposioApi, pngLogo } from "./composio-api.ts";
import type { FakeToolkit } from "./composio-api.ts";
import { outcome } from "./connect.ts";

// Catalog entries' logos: connect fetches each from Composio's logo host
// and hands core only images it checked, so the page shows them from the
// deployment's own origin. A logo that isn't one, is too big or doesn't
// come is none, and the page draws the entry's first letter.

const tool = { slug: "TOOL" };

/** A logo address on Composio's logo host, carrying a login. */
const withLogin = new URL("https://logos.composio.dev/api/with_login");
withLogin.username = "someone";
const toolkits: FakeToolkit[] = [
  { slug: "hubspot", name: "HubSpot", tools: [tool] },
  { slug: "linear", name: "Linear", tools: [tool] },
  // Logos Composio's list places elsewhere, or not at all.
  {
    slug: "elsewhere",
    name: "Elsewhere",
    tools: [tool],
    logo: "https://attacker.example/api/elsewhere",
  },
  {
    slug: "plain_http",
    name: "Plain HTTP",
    tools: [tool],
    logo: "http://logos.composio.dev/api/plain_http",
  },
  {
    slug: "with_login",
    name: "With login",
    tools: [tool],
    logo: withLogin.href,
  },
  { slug: "no_logo", name: "No logo", tools: [tool], logo: null },
  // Listed by Composio, but not in the catalog.
  { slug: "unmanaged", name: "Unmanaged", managed: false, tools: [tool] },
];

const { state: composio } = fakeComposioApi(toolkits);

const logoOf = async (id: string) =>
  await exports.default.catalogLogo({ source: "composio", id });

/** An entry's logo, fetched afresh: none of the logos kept so far. */
const catalogLogoAfresh = async (id: string) => {
  forgetCatalogLogos();
  return await logoOf(id);
};

/** The logo host answering `body` for HubSpot, sent as `contentType`. */
const hubspotAnswers = (
  body: BodyInit | null,
  contentType = "image/png"
): void => {
  composio.logos.set(
    "hubspot",
    () => new Response(body, { headers: { "content-type": contentType } })
  );
};

const encoded = (text: string): Uint8Array => new TextEncoder().encode(text);

/** UTF-8's byte-order mark. */
const byteOrderMark = [0xef, 0xbb, 0xbf];

const svg =
  '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" style="fill:#000"/></svg>';

describe("a catalog entry's logo", () => {
  it("is named by its address on the deployment's own origin, never Composio's", async () => {
    const { entries } = await exports.default.catalog();
    expect(
      Object.fromEntries(entries.map(({ id, logo }) => [id, logo]))
    ).toStrictEqual({
      microsoft: null,
      google: null,
      hubspot: catalogLogoUrl("composio", "hubspot"),
      linear: catalogLogoUrl("composio", "linear"),
      // Not on Composio's logo host over https, or no address at all.
      elsewhere: null,
      plain_http: null,
      with_login: null,
      no_logo: null,
    });
    expect(catalogLogoUrl("composio", "hubspot")).toBe(
      "/api/catalog/logos/composio/hubspot"
    );
  });

  it("is fetched from Composio's logo host without connect's key, following no redirect", async () => {
    const logo = await logoOf("hubspot");
    expect(logo).toStrictEqual({ contentType: "image/png", bytes: pngLogo });
    expect(composio.logoRequests).toStrictEqual([
      { path: "/api/hubspot", keyed: false, followsRedirects: false },
    ]);
  });

  it("goes by what its bytes are, not the type Composio sends", async () => {
    hubspotAnswers(svg, "text/html");
    composio.logos.set(
      "linear",
      () =>
        new Response("<html><script>alert(1)</script></html>", {
          headers: { "content-type": "image/svg+xml" },
        })
    );
    await expect(logoOf("hubspot")).resolves.toStrictEqual({
      contentType: "image/svg+xml",
      bytes: encoded(svg),
    });
    await expect(logoOf("linear")).resolves.toBeNull();
  });

  it("serves each image type by its signature", async () => {
    const images = {
      "image/png": pngLogo,
      "image/jpeg": Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 0x10),
      "image/gif": encoded("GIF89a\u0001\u0000\u0001\u0000"),
      "image/webp": encoded("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "),
      // After a byte-order mark, white space and a comment.
      "image/svg+xml": Uint8Array.of(
        ...byteOrderMark,
        ...encoded("  <!-- logo -->\n"),
        ...encoded(svg)
      ),
    };
    const served = [];
    for (const [type, bytes] of Object.entries(images)) {
      hubspotAnswers(bytes, "image/*");
      // oxlint-disable-next-line no-await-in-loop -- one logo at a time, each fetched afresh
      const logo = await catalogLogoAfresh("hubspot");
      served.push([type, logo?.contentType ?? null]);
    }
    expect(served).toStrictEqual(
      Object.keys(images).map((type) => [type, type])
    );
  });

  it("is none when it isn't an image connect serves", async () => {
    const refused = [
      encoded('{"error":"not found"}'),
      encoded("<!DOCTYPE html><html><body><svg></svg></body></html>"),
      encoded("BM\u0000\u0000"),
      // Not UTF-8.
      Uint8Array.of(0x3c, 0x73, 0x76, 0x67, 0x20, 0xff, 0x3e),
      new Uint8Array(0),
    ];
    const answers = [];
    for (const bytes of refused) {
      hubspotAnswers(bytes);
      // oxlint-disable-next-line no-await-in-loop -- one logo at a time, each fetched afresh
      answers.push(await catalogLogoAfresh("hubspot"));
    }
    expect(answers).toStrictEqual(refused.map(() => null));
  });

  it("is none when it is over the size cap, read no further than the cap", async () => {
    let sent = 0;
    hubspotAnswers(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(pngLogo);
          sent += pngLogo.byteLength;
        },
        pull: (controller) => {
          const chunk = new Uint8Array(64 * 1024);
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
      })
    );
    await expect(logoOf("hubspot")).resolves.toBeNull();
    expect(sent).toBeGreaterThan(maxLogoBytes);
    expect(sent).toBeLessThan(maxLogoBytes * 2);
  });

  it("is none when the logo host answers an error or a redirect", async () => {
    const answers = [
      new Response("Not found", { status: 404 }),
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/logo.png" },
      }),
    ];
    const logos = [];
    for (const answer of answers) {
      composio.logos.set("hubspot", () => answer);
      // oxlint-disable-next-line no-await-in-loop -- one logo at a time, each fetched afresh
      logos.push(await catalogLogoAfresh("hubspot"));
    }
    expect(logos).toStrictEqual([null, null]);
    // Only the logo host was asked: the redirect led nowhere.
    expect(
      composio.logoRequests.map(({ followsRedirects }) => followsRedirects)
    ).toStrictEqual([false, false]);
  });

  it("is fetched only for an entry the catalog lists with a logo on Composio's host", async () => {
    const asked = [
      { source: "composio", id: "elsewhere" },
      { source: "composio", id: "plain_http" },
      { source: "composio", id: "with_login" },
      { source: "composio", id: "no_logo" },
      { source: "composio", id: "unmanaged" },
      { source: "composio", id: "nobody" },
      { source: "composio", id: "../toolkits" },
      { source: "native", id: "microsoft" },
    ] as const;
    const logos = await Promise.all(
      asked.map(async (request) => await exports.default.catalogLogo(request))
    );
    expect(logos).toStrictEqual(asked.map(() => null));
    expect(composio.logoRequests).toStrictEqual([]);
  });

  it("refuses a request it can't read", async () => {
    const requests = [
      { source: "elsewhere", id: "hubspot" },
      { source: "composio", id: 7 },
      { source: "composio", id: "hubspot", url: "https://attacker.example" },
    ];
    const ends = await Promise.all(
      requests.map(
        async (request) => await outcome(exports.default.catalogLogo(request))
      )
    );
    expect(ends).toStrictEqual(requests.map(() => "connect.invalid"));
  });

  it("is kept, a refused one too, and asked for once by people looking at the same time", async () => {
    composio.logos.set("linear", () => new Response("<html>"));
    await Promise.all([logoOf("hubspot"), logoOf("hubspot"), logoOf("linear")]);
    await expect(logoOf("hubspot")).resolves.toMatchObject({
      contentType: "image/png",
    });
    await expect(logoOf("linear")).resolves.toBeNull();
    expect(composio.logoRequests.map(({ path }) => path)).toStrictEqual([
      "/api/hubspot",
      "/api/linear",
    ]);
    // A day on, each is fetched again.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 25 * 60 * 60 * 1000);
    await logoOf("hubspot");
    expect(composio.logoRequests).toHaveLength(3);
  });

  it("is none while it doesn't come, and asked for again next time", async () => {
    const passing = [
      () => new Response("Service Unavailable", { status: 503 }),
      () => new Response("Slow down", { status: 429 }),
      () => {
        throw new Error("The connection broke");
      },
      // Breaking off after its first bytes, while connect reads it.
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              controller.enqueue(pngLogo.subarray(0, 8));
            },
            pull: (controller) => {
              controller.error(new Error("The connection broke"));
            },
          }),
          { headers: { "content-type": "image/png" } }
        ),
    ];
    const logos = [];
    for (const answer of passing) {
      composio.logos.set("hubspot", answer);
      // oxlint-disable-next-line no-await-in-loop -- one failure at a time
      logos.push(await logoOf("hubspot"));
    }
    composio.logos.delete("hubspot");
    logos.push(await logoOf("hubspot"));
    expect(logos.map((logo) => logo?.contentType ?? null)).toStrictEqual([
      null,
      null,
      null,
      null,
      "image/png",
    ]);
    expect(composio.logoRequests).toHaveLength(5);
  });

  it("is none while Composio doesn't list the catalog, or connect has no key", async () => {
    composio.health = "down";
    await expect(logoOf("hubspot")).resolves.toBeNull();
    composio.health = "up";
    await expect(
      catalogLogo(
        { ...env, COMPOSIO_API_KEY: undefined },
        { source: "composio", id: "hubspot" }
      )
    ).resolves.toBeNull();
    expect(composio.logoRequests).toStrictEqual([]);
  });
});
