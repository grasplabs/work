import { packageErrors, registryLimits } from "@grasp-os/shared/packages";
import { exports } from "cloudflare:workers";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { npmRegistryFake } from "./npm-registry-fake.ts";

// The npm registry through connect (src/npm.ts), from its threat model:
// being sent elsewhere by a redirect, other bytes than the integrity hash
// names, answers too large or that lie about their size, names that would
// build another URL, and credentials or package text going where they
// shouldn't. The registry is a strict fake of npm's (npm-registry-fake.ts):
// real gzipped tarballs, real SHA-512 integrity, JSON 404s.

/**
 * The registry behind connect's fetch, for each test in the file, and
 * every request that left connect for any other host.
 */
const fakeInternet = () => {
  const registry = npmRegistryFake();
  const elsewhere: string[] = [];
  beforeEach(() => {
    registry.reset();
    elsewhere.length = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin === registry.origin) {
        return await registry.answer(request);
      }
      elsewhere.push(request.url);
      return new Response("Somewhere else");
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  return { registry, elsewhere };
};

const { registry, elsewhere } = fakeInternet();

const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return packageErrors.codeOf(error) ?? String(error);
  }
};

const connect = exports.default;

/**
 * An answer streamed in `count` chunks of `size` bytes of `fill`, made
 * only as they are read: how many were pulled, and whether the reader
 * cancelled the rest.
 */
const streamed = (count: number, size: number, fill = 0x20) => {
  const state = { pulled: 0, cancelled: false };
  const respond = (): Response =>
    new Response(
      new ReadableStream<Uint8Array>(
        {
          pull: (controller) => {
            if (state.pulled === count) {
              controller.close();
              return;
            }
            state.pulled += 1;
            controller.enqueue(new Uint8Array(size).fill(fill));
          },
          cancel: () => {
            state.cancelled = true;
          },
        },
        { highWaterMark: 0 }
      )
    );
  return { state, respond };
};

/** An answer whose connection is lost after its first bytes. */
const broken = (): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode('{"name":"le'));
        controller.error(new TypeError("Network connection lost."));
      },
    })
  );

const leftPad = {
  name: "left-pad",
  version: "1.3.0",
  manifest: { license: "WTFPL", main: "index.js" },
  publishedAt: "2026-09-01T10:00:00.000Z",
  files: { "index.js": "module.exports = (s, n) => String(s).padStart(n);" },
};

describe("a package's metadata", () => {
  it("passes on each version's ranges, integrity, licence and publication, and none of its text", async () => {
    await registry.publish(leftPad);
    await registry.publish({
      name: "left-pad",
      version: "1.4.0",
      manifest: {
        license: { type: "MIT" },
        dependencies: { "is-number": "^7.0.0" },
        peerDependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
        peerDependenciesMeta: { "react-dom": { optional: true } },
        scripts: { postinstall: "node steal.js", test: "jest" },
        deprecated: "Use String.prototype.padStart",
      },
      publishedAt: "2026-10-01T10:00:00.000Z",
    });
    const metadata = await connect.npmMetadata("left-pad");
    expect(metadata.name).toBe("left-pad");
    expect(metadata.versions).toStrictEqual([
      {
        version: "1.3.0",
        publishedAt: "2026-09-01T10:00:00.000Z",
        integrity: registry.integrityOf("left-pad", "1.3.0"),
        license: "WTFPL",
        dependencies: {},
        optionalDependencies: {},
        peerDependencies: {},
        optionalPeers: [],
        bundlesDependencies: false,
        installScripts: [],
        gypfile: false,
        os: [],
        cpu: [],
        deprecated: false,
      },
      {
        version: "1.4.0",
        publishedAt: "2026-10-01T10:00:00.000Z",
        integrity: registry.integrityOf("left-pad", "1.4.0"),
        license: "MIT",
        dependencies: { "is-number": "^7.0.0" },
        optionalDependencies: {},
        peerDependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
        optionalPeers: ["react-dom"],
        bundlesDependencies: false,
        installScripts: ["postinstall"],
        gypfile: false,
        os: [],
        cpu: [],
        deprecated: true,
      },
    ]);
    expect(JSON.stringify(metadata)).not.toContain("instructed");
    expect(JSON.stringify(metadata)).not.toContain("steal");
  });

  it("asks the registry alone, at the package's own path, with no credentials", async () => {
    await registry.publish({ ...leftPad, name: "@acme/pad" });
    await connect.npmMetadata("@acme/pad");
    expect(registry.asked.map(({ path }) => path)).toStrictEqual([
      "/@acme%2fpad",
    ]);
    const headers = registry.asked[0]?.headers ?? {};
    // The full packument (npm's abbreviated one has no publication
    // times), and no credentials.
    expect({
      accept: headers.accept,
      authorization: "authorization" in headers,
      cookie: "cookie" in headers,
    }).toStrictEqual({
      accept: "application/json",
      authorization: false,
      cookie: false,
    });
    expect(
      registry.asked.map(({ method, body }) => [method, body])
    ).toStrictEqual([["GET", ""]]);
    expect(elsewhere).toStrictEqual([]);
  });

  it("is not found when the registry has no such package", async () => {
    await expect(outcome(connect.npmMetadata("no-such-package"))).resolves.toBe(
      "package.not_found"
    );
  });

  it("refuses names that would build another URL, asking nothing", async () => {
    const names = [
      "../../etc/passwd",
      "left-pad/../../admin",
      "@acme/pad/extra",
      "https://evil.example/x",
      "left-pad?x=1",
      "left-pad#x",
      "%2e%2e",
      "Left-Pad",
      "",
      "a".repeat(215),
      42,
    ];
    for (const name of names) {
      // One at a time, so a refusal names its input.
      // oxlint-disable-next-line no-await-in-loop
      expect([name, await outcome(connect.npmMetadata(name))]).toStrictEqual([
        name,
        "package.invalid",
      ]);
    }
    expect(registry.asked).toStrictEqual([]);
  });

  it("leaves out versions whose metadata isn't npm's, and says when one has no SHA-512", async () => {
    await registry.publish(leftPad);
    await registry.publish({ ...leftPad, version: "1.0.0", sha1Only: true });
    await registry.publish({
      ...leftPad,
      version: "1.1.0",
      manifest: { dependencies: { "is-number": 7 } },
    });
    await registry.publish({
      ...leftPad,
      version: "1.2.0",
      manifest: { dependencies: { "../escape": "1.0.0" } },
    });
    await registry.publish({
      ...leftPad,
      version: "1.2.1",
      manifest: { hasInstallScript: true, gypfile: true, os: ["darwin"] },
    });
    const { versions } = await connect.npmMetadata("left-pad");
    expect(
      versions.map(({ version, integrity, installScripts, gypfile, os }) => ({
        version,
        sha512: integrity !== null,
        installScripts,
        gypfile,
        os,
      }))
    ).toStrictEqual([
      {
        version: "1.3.0",
        sha512: true,
        installScripts: [],
        gypfile: false,
        os: [],
      },
      {
        version: "1.0.0",
        sha512: false,
        installScripts: [],
        gypfile: false,
        os: [],
      },
      {
        version: "1.2.1",
        sha512: true,
        installScripts: ["hasInstallScript"],
        gypfile: true,
        os: ["darwin"],
      },
    ]);
  });

  it("fails as unavailable when the registry fails, answers what isn't JSON, or another package", async () => {
    registry.override("/broken", () => new Response("Oops", { status: 503 }));
    registry.override("/garbled", () => new Response("<html>not json</html>"));
    registry.override("/other", () =>
      Response.json({ name: "left-pad", versions: {} })
    );
    await expect(
      Promise.all(
        ["broken", "garbled", "other"].map(
          async (name) => await outcome(connect.npmMetadata(name))
        )
      )
    ).resolves.toStrictEqual([
      "package.registry_unavailable",
      "package.registry_unavailable",
      "package.registry_unavailable",
    ]);
  });

  it("fails as unavailable when the registry's answer breaks off mid-body", async () => {
    await registry.publish(leftPad);
    const integrity = registry.integrityOf("left-pad", "1.3.0") ?? "";
    registry.override("/left-pad", broken);
    registry.override(registry.tarballPath("left-pad", "1.3.0"), broken);
    expect([
      await outcome(connect.npmMetadata("left-pad")),
      await outcome(
        connect.npmTarball({ name: "left-pad", version: "1.3.0", integrity })
      ),
    ]).toStrictEqual([
      "package.registry_unavailable",
      "package.registry_unavailable",
    ]);
  });

  it("stops pulling a streamed answer once it passes the limit, and cancels the rest", async () => {
    await registry.publish(leftPad);
    const integrity = registry.integrityOf("left-pad", "1.3.0") ?? "";
    const chunk = 1024 * 1024;
    const metadata = streamed(registryLimits.metadataBytes / chunk + 40, chunk);
    const tarball = streamed(registryLimits.archiveBytes / chunk + 40, chunk);
    registry.override("/left-pad", metadata.respond);
    registry.override(
      registry.tarballPath("left-pad", "1.3.0"),
      tarball.respond
    );
    const outcomes = [
      await outcome(connect.npmMetadata("left-pad")),
      await outcome(
        connect.npmTarball({ name: "left-pad", version: "1.3.0", integrity })
      ),
    ];
    expect({
      outcomes,
      metadata: metadata.state,
      tarball: tarball.state,
    }).toStrictEqual({
      outcomes: ["package.too_large", "package.too_large"],
      // The chunk that crossed the limit is the last one read.
      metadata: {
        pulled: registryLimits.metadataBytes / chunk + 1,
        cancelled: true,
      },
      tarball: {
        pulled: registryLimits.archiveBytes / chunk + 1,
        cancelled: true,
      },
    });
  });

  it("passes on only the newest versions when a package has more than it keeps", async () => {
    const count = registryLimits.versions + 25;
    const day = 24 * 60 * 60 * 1000;
    const start = Date.parse("2020-01-01T00:00:00.000Z");
    const versions: Record<string, unknown> = {};
    const time: Record<string, string> = {};
    // Listed newest first, so keeping the registry's first ones would be
    // the wrong ones.
    for (let index = count - 1; index >= 0; index -= 1) {
      const version = `1.0.${index}`;
      versions[version] = {
        name: "many",
        version,
        dist: { integrity: `sha512-${"A".repeat(86)}==` },
      };
      time[version] = new Date(start + index * day).toISOString();
    }
    // One more, whose time isn't one: it ranks last, not first.
    versions["2.0.0"] = {
      name: "many",
      version: "2.0.0",
      dist: { integrity: `sha512-${"A".repeat(86)}==` },
    };
    time["2.0.0"] = "zzz";
    const body = JSON.stringify({ name: "many", versions, time });
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(
      registryLimits.metadataBytes
    );
    registry.override("/many", () => new Response(body));
    const metadata = await connect.npmMetadata("many");
    const kept = metadata.versions.map(({ version }) => version);
    expect({
      count: kept.length,
      oldestKept: kept.includes("1.0.25"),
      newestDropped: kept.includes("1.0.24"),
      undated: kept.includes("2.0.0"),
    }).toStrictEqual({
      count: registryLimits.versions,
      oldestKept: true,
      newestDropped: false,
      undated: false,
    });
  });

  it("stops reading metadata past its limit, whatever Content-Length says", async () => {
    const huge = `{"name":"huge","versions":{},"readme":"${"x".repeat(registryLimits.metadataBytes)}"}`;
    registry.override(
      "/huge",
      () => new Response(huge, { headers: { "content-length": "100" } })
    );
    await expect(outcome(connect.npmMetadata("huge"))).resolves.toBe(
      "package.too_large"
    );
  });
});

describe("redirects", () => {
  it("follows one within the registry", async () => {
    await registry.publish({ ...leftPad, name: "@acme/pad" });
    registry.override(
      "/@acme%2fpad",
      () =>
        new Response(null, {
          status: 301,
          headers: { location: "https://registry.npmjs.org/@acme%2Fpad" },
        })
    );
    registry.override(
      "/@acme%2Fpad",
      () =>
        new Response(null, { status: 308, headers: { location: "/@acme/pad" } })
    );
    const { name, versions } = await connect.npmMetadata("@acme/pad");
    expect([name, versions.map(({ version }) => version)]).toStrictEqual([
      "@acme/pad",
      ["1.3.0"],
    ]);
    expect(registry.asked.map(({ path }) => path)).toStrictEqual([
      "/@acme%2fpad",
      "/@acme%2Fpad",
      "/@acme/pad",
    ]);
  });

  it("takes no answer for another package than the one asked for", async () => {
    await registry.publish(leftPad);
    registry.override(
      "/moved-pad",
      () =>
        new Response(null, { status: 301, headers: { location: "/left-pad" } })
    );
    await expect(outcome(connect.npmMetadata("moved-pad"))).resolves.toBe(
      "package.registry_unavailable"
    );
  });

  it("refuses one to anywhere but the registry, without following it", async () => {
    const targets = [
      "https://evil.example/left-pad",
      "http://registry.npmjs.org/left-pad",
      // Credentials in the URL, put together so no scanner takes them
      // for real ones.
      `https://${["user", "pass"].join(":")}@registry.npmjs.org/left-pad`,
      "https://registry.npmjs.org:8443/left-pad",
      "https://registry.npmjs.org.evil.example/left-pad",
      "//evil.example/left-pad",
      "ftp://registry.npmjs.org/left-pad",
      "http://169.254.169.254/latest/meta-data",
    ];
    for (const [index, location] of targets.entries()) {
      registry.override(
        `/away-${index}`,
        () => new Response(null, { status: 302, headers: { location } })
      );
    }
    const outcomes = await Promise.all(
      targets.map(
        async (_, index) => await outcome(connect.npmMetadata(`away-${index}`))
      )
    );
    expect(new Set(outcomes)).toStrictEqual(
      new Set(["package.redirect_refused"])
    );
    expect(elsewhere).toStrictEqual([]);
  });

  it("refuses a redirect without a readable target, and one that goes on too long", async () => {
    registry.override("/nowhere", () => new Response(null, { status: 307 }));
    registry.override(
      "/loop",
      () => new Response(null, { status: 302, headers: { location: "/loop" } })
    );
    await expect(outcome(connect.npmMetadata("nowhere"))).resolves.toBe(
      "package.redirect_refused"
    );
    await expect(outcome(connect.npmMetadata("loop"))).resolves.toBe(
      "package.redirect_refused"
    );
    expect(registry.asked.filter(({ path }) => path === "/loop")).toHaveLength(
      registryLimits.redirects + 1
    );
  });

  it("refuses a tarball's redirect to another host", async () => {
    await registry.publish(leftPad);
    const integrity = registry.integrityOf("left-pad", "1.3.0") ?? "";
    registry.override(
      registry.tarballPath("left-pad", "1.3.0"),
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://cdn.evil.example/left-pad.tgz" },
        })
    );
    await expect(
      outcome(
        connect.npmTarball({ name: "left-pad", version: "1.3.0", integrity })
      )
    ).resolves.toBe("package.redirect_refused");
    expect(elsewhere).toStrictEqual([]);
  });
});

describe("a tarball", () => {
  it("is passed on when its SHA-512 is the integrity asked for", async () => {
    await registry.publish(leftPad);
    const integrity = registry.integrityOf("left-pad", "1.3.0") ?? "";
    const bytes = await connect.npmTarball({
      name: "left-pad",
      version: "1.3.0",
      integrity,
    });
    // A gzip stream.
    expect([...bytes.subarray(0, 2)]).toStrictEqual([0x1f, 0x8b]);
    expect(registry.asked.map(({ path }) => path)).toStrictEqual([
      "/left-pad/-/left-pad-1.3.0.tgz",
    ]);
  });

  it("is fetched from the registry's own path for it, never the URL the metadata names", async () => {
    await registry.publish({ ...leftPad, name: "@acme/pad" });
    const integrity = registry.integrityOf("@acme/pad", "1.3.0") ?? "";
    await connect.npmTarball({
      name: "@acme/pad",
      version: "1.3.0",
      integrity,
    });
    expect(registry.asked.map(({ path }) => path)).toStrictEqual([
      "/@acme/pad/-/pad-1.3.0.tgz",
    ]);
  });

  it("is refused when the registry sends other bytes", async () => {
    await registry.publish(leftPad);
    const integrity = registry.integrityOf("left-pad", "1.3.0") ?? "";
    registry.override(
      registry.tarballPath("left-pad", "1.3.0"),
      () => new Response(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0]))
    );
    await expect(
      outcome(
        connect.npmTarball({ name: "left-pad", version: "1.3.0", integrity })
      )
    ).resolves.toBe("package.integrity_mismatch");
  });

  it("is refused when the metadata named other bytes than the registry has", async () => {
    await registry.publish({
      ...leftPad,
      integrity: `sha512-${"B".repeat(86)}==`,
    });
    const integrity = registry.integrityOf("left-pad", "1.3.0") ?? "";
    await expect(
      outcome(
        connect.npmTarball({ name: "left-pad", version: "1.3.0", integrity })
      )
    ).resolves.toBe("package.integrity_mismatch");
  });

  it("is asked for by SHA-512 only, an exact version and an npm name", async () => {
    await registry.publish(leftPad);
    const integrity = registry.integrityOf("left-pad", "1.3.0") ?? "";
    const asks = [
      { name: "left-pad", version: "1.3.0", integrity: "sha1-abc" },
      { name: "left-pad", version: "^1.3.0", integrity },
      { name: "left-pad", version: "latest", integrity },
      { name: "../left-pad", version: "1.3.0", integrity },
      { name: "left-pad", version: "1.3.0", integrity, url: "https://x" },
    ];
    const outcomes = await Promise.all(
      asks.map(async (ask) => await outcome(connect.npmTarball(ask)))
    );
    expect(new Set(outcomes)).toStrictEqual(new Set(["package.invalid"]));
    expect(registry.asked).toStrictEqual([]);
  });

  it("is cut off past its limit, whatever Content-Length says", async () => {
    await registry.publish(leftPad);
    const integrity = registry.integrityOf("left-pad", "1.3.0") ?? "";
    registry.override(
      registry.tarballPath("left-pad", "1.3.0"),
      () =>
        new Response(new Uint8Array(registryLimits.archiveBytes + 1), {
          headers: { "content-length": "1024" },
        })
    );
    await expect(
      outcome(
        connect.npmTarball({ name: "left-pad", version: "1.3.0", integrity })
      )
    ).resolves.toBe("package.too_large");
  });

  it("is not found for a version the registry doesn't have", async () => {
    await registry.publish(leftPad);
    const integrity = registry.integrityOf("left-pad", "1.3.0") ?? "";
    await expect(
      outcome(
        connect.npmTarball({ name: "left-pad", version: "9.9.9", integrity })
      )
    ).resolves.toBe("package.not_found");
  });
});

describe("reading large metadata", () => {
  it("reads a packument of several MiB sent in small chunks whole, byte for byte", async () => {
    await registry.publish(leftPad);
    const own = await registry.answer(
      new Request(`${registry.origin}/left-pad`)
    );
    const packument: unknown = await own.json();
    // Past the first buffer twice over, so it has to grow, and every
    // chunk lands after the ones before it.
    const big = new TextEncoder().encode(
      JSON.stringify({
        ...(typeof packument === "object" ? packument : {}),
        readme: "é".repeat(2 * 1024 * 1024),
      })
    );
    const chunk = 16 * 1024;
    registry.override("/left-pad", () => {
      let at = 0;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull: (controller) => {
              if (at >= big.byteLength) {
                controller.close();
                return;
              }
              controller.enqueue(big.slice(at, at + chunk));
              at += chunk;
            },
          },
          { highWaterMark: 0 }
        )
      );
    });
    const metadata = await connect.npmMetadata("left-pad");
    expect({
      bytes: big.byteLength > 3 * 1024 * 1024,
      versions: metadata.versions.map(({ version, integrity }) => ({
        version,
        integrity,
      })),
    }).toStrictEqual({
      bytes: true,
      versions: [
        {
          version: "1.3.0",
          integrity: registry.integrityOf("left-pad", "1.3.0"),
        },
      ],
    });
  });

  it("refuses at once, as busy, metadata past what this isolate reads at once, and reads again once that is given back", async () => {
    await registry.publish(leftPad);
    await registry.publish({ ...leftPad, name: "right-pad" });
    const declared = registryLimits.metadataBytes;
    const { promise: held, resolve: holding } =
      Promise.withResolvers<boolean>();
    let fail: ((error: Error) => void) | undefined;
    // One answer that declares 20 MiB and holds: its read keeps its share.
    registry.override(
      "/left-pad",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              fail = (error) => {
                controller.error(error);
              };
              holding(true);
            },
          }),
          { headers: { "content-length": String(declared) } }
        )
    );
    registry.override(
      "/right-pad",
      () =>
        new Response("{}", {
          headers: { "content-length": String(declared) },
        })
    );
    const first = outcome(connect.npmMetadata("left-pad"));
    await held;
    const second = await outcome(connect.npmMetadata("right-pad"));
    fail?.(new TypeError("Network connection lost."));
    const firstEnded = await first;
    // Given back however the first ended: the next read goes ahead.
    registry.reset();
    await registry.publish({ ...leftPad, name: "right-pad" });
    const after = await outcome(connect.npmMetadata("right-pad"));
    expect({ second, firstEnded, after }).toStrictEqual({
      second: "package.registry_busy",
      firstEnded: "package.registry_unavailable",
      after: "ok",
    });
  });
});

describe("refusing metadata as busy", () => {
  it("cancels the registry's answer whenever it refuses one as busy, before or after its size is known", async () => {
    // Two answers that hold for a moment, then break off, declaring
    // between them every byte of the isolate's 40 MiB budget for metadata
    // (src/npm.ts): the most one may be, and the rest. Each ends on its
    // own: one request's stream can't be ended from another's.
    let holding = 0;
    const held = (declared: number) => (): Response => {
      holding += 1;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull: async (controller) => {
              await scheduler.wait(1000);
              controller.error(new TypeError("Network connection lost."));
            },
          },
          { highWaterMark: 0 }
        ),
        { headers: { "content-length": String(declared) } }
      );
    };
    registry.override("/held-one", held(registryLimits.metadataBytes));
    registry.override(
      "/held-two",
      held(40 * 1024 * 1024 - registryLimits.metadataBytes)
    );
    const ending = [
      outcome(connect.npmMetadata("held-one")),
      outcome(connect.npmMetadata("held-two")),
    ];
    // The count moves as connect asks the registry, not in this loop.
    // oxlint-disable-next-line no-unmodified-loop-condition
    while (holding < 2) {
      // oxlint-disable-next-line no-await-in-loop -- until both are asked
      await scheduler.wait(10);
    }
    // One that says nothing of its size, refused once it would take its
    // first buffer; and one that declares its size, refused at once.
    const unsized = streamed(4, 1024);
    registry.override("/unsized", unsized.respond);
    const sized = streamed(4, 1024);
    registry.override(
      "/sized",
      () =>
        new Response(sized.respond().body, {
          headers: { "content-length": "4096" },
        })
    );
    const refused = [
      await outcome(connect.npmMetadata("unsized")),
      await outcome(connect.npmMetadata("sized")),
    ];
    const ended = await Promise.all(ending);
    expect({
      refused,
      cancelled: [unsized.state.cancelled, sized.state.cancelled],
      ended,
    }).toStrictEqual({
      refused: ["package.registry_busy", "package.registry_busy"],
      cancelled: [true, true],
      ended: ["package.registry_unavailable", "package.registry_unavailable"],
    });
  });
});
