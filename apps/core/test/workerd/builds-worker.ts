import { npmRegistryOrigin } from "@grasp-os/shared/dependencies";
import { sha256HexOfBytes, sha512Integrity } from "@grasp-os/shared/encoding";
import {
  packageBuildAnswerSchema,
  packageLimits,
  targetConditions,
} from "@grasp-os/shared/packages";
import type { GraspLock, PackageTarball } from "@grasp-os/shared/packages";

import { packageBuilder } from "../../src/packages/builder.ts";
import type { PackageBuilderEnv } from "../../src/packages/builder.ts";
import { PlatformBoundError } from "../../src/platform-sandbox.ts";
import { runInSession } from "../../src/sandbox-session.ts";
import { SandboxUnavailableError } from "../../src/sandboxed.ts";

// The package builder on plain workerd
// (scripts/workerd-sandbox-builds.test.ts): the same `packageBuilder` a
// resolve and a build run, with `SANDBOX_HOST` bound to the sandbox
// supervisor as on-prem binds it. The builder's code is the one core's
// build makes, given as the static assets give it, or one a package that
// took it over would run instead.

interface StandInEnv {
  SANDBOX_HOST: Fetcher;
  RUNTIME_PROFILE: string;
  SANDBOX_DEADLINE_MS?: string;
  /** The package builder and esbuild's WebAssembly, as core's build makes them. */
  PACKAGE_BUILDER: string;
  ESBUILD_WASM: ArrayBuffer;
}

/** A package builder's module of these methods: what a package that took it over runs. */
const takenOver = (methods: string): string =>
  `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint { ${methods} }`;

/** What a package that took the builder over could run, by name. */
const hostile: Readonly<Record<string, string>> = {
  // Never returns, once it has its first chunk.
  busy: takenOver(
    "async inspectRead(limits, headers, read) { await read(headers[0].key, 0); for (;;) {} }"
  ),
  // Allocates without end.
  memory: takenOver(`async inspectRead(limits, headers, read) {
    await read(headers[0].key, 0);
    const held = [];
    for (;;) {
      held.push(new Uint8Array(16 * 1024 * 1024).fill(1));
      const until = Date.now() + 20;
      while (Date.now() < until) {}
    }
  }`),
  // Reads a tarball's start again.
  reread: takenOver(`async inspectRead(limits, headers, read) {
    await read(headers[0].key, 0);
    try {
      await read(headers[0].key, 0);
      return [{ key: "read twice" }];
    } catch {
      return [{ key: "refused" }];
    }
  }`),
  // Reads a tarball of several chunks: its second chunk, then its first
  // again, then past its third, each refused or not.
  rereadLater: takenOver(`async inspectRead(limits, headers, read) {
    const { key } = headers[0];
    const tried = async (offset) => {
      try {
        await read(key, offset);
        return "read";
      } catch {
        return "refused";
      }
    };
    const first = await read(key, 0);
    const second = await tried(first.byteLength);
    const again = await tried(0);
    const skipped = await tried(3 * first.byteLength);
    return [{ key: [second, again, skipped].join(" ") }];
  }`),
  // Writes back more of an artifact than it may be.
  overwrite: takenOver(`async buildRead(request, read, write) {
    const chunk = new Uint8Array(1024 * 1024).fill(7);
    let written = 0;
    try {
      for (;;) {
        await write("index.js", chunk);
        written += chunk.byteLength;
      }
    } catch {
      return { ok: false, refusals: ["written " + written] };
    }
  }`),
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * What the built package exports: the numbers to 200,000, in order, some
 * 1.3 MB, so its bundle is larger than a chunk the builder writes back
 * (1 MiB), and no part of it repeats another, so a chunk out of place
 * shows.
 */
const counted = Array.from({ length: 200_001 }, (_, at) => at).join(",");

/** One ustar header, as tar writes it. */
const header = (path: string, size: number): Uint8Array => {
  const block = new Uint8Array(512);
  const put = (text: string, at: number): void => {
    block.set(encoder.encode(text), at);
  };
  put(path, 0);
  put("0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124);
  put("00000000000\0", 136);
  put("        ", 148);
  put("0", 156);
  put("ustar\u000000", 257);
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
};

/** A gzipped tarball of these files. */
const tarballOf = async (
  files: Record<string, Uint8Array>
): Promise<Uint8Array> => {
  const parts: Uint8Array[] = [];
  for (const [path, content] of Object.entries(files)) {
    parts.push(
      header(path, content.byteLength),
      content,
      new Uint8Array((512 - (content.byteLength % 512)) % 512)
    );
  }
  parts.push(new Uint8Array(1024));
  const zipped = new Blob(parts)
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(zipped).arrayBuffer());
};

/** The package `kind` names, as the registry would serve it. */
const packageOf = async (kind: string): Promise<PackageTarball> => {
  const name = `${kind}-package`;
  const manifest = encoder.encode(
    JSON.stringify({
      name,
      version: "1.0.0",
      type: "module",
      main: "index.js",
      license: "MIT",
    })
  );
  const files: Record<string, Uint8Array> = {
    "package/package.json": manifest,
    "package/index.js": encoder.encode("export const answer = 42;\n"),
  };
  if (kind === "bomb") {
    // Zeros gzip shrinks a thousandfold: past what a package may unpack to.
    files["package/zeros.bin"] = new Uint8Array(
      packageLimits.extractedBytes + 1024 * 1024
    );
  }
  if (kind === "built") {
    files["package/index.js"] = encoder.encode(
      `export const counted = "${counted}";\n`
    );
  }
  if (kind === "large" || kind === "built") {
    // Three tarball chunks of noise gzip can't shrink, read whole and in order.
    const noise = new Uint8Array(3 * 1024 * 1024);
    for (let at = 0; at < noise.byteLength; at += 65_536) {
      crypto.getRandomValues(noise.subarray(at, at + 65_536));
    }
    files["package/noise.bin"] = noise;
  }
  const tarball = await tarballOf(files);
  return {
    key: `${name}@1.0.0`,
    name,
    version: "1.0.0",
    integrity: await sha512Integrity(tarball),
    tarball,
  };
};

/** An approved lock of `pkg` alone, its browser target importing it. */
const lockOf = (pkg: PackageTarball): GraspLock => ({
  lockfileVersion: 1,
  registry: npmRegistryOrigin,
  requested: { [pkg.name]: pkg.version },
  direct: { [pkg.name]: pkg.version },
  platformPeers: {},
  targets: {
    browser: { conditions: [...targetConditions.browser], entries: [pkg.name] },
  },
  packages: {
    [pkg.key]: {
      name: pkg.name,
      version: pkg.version,
      integrity: pkg.integrity,
      license: "MIT",
      publishedAt: "2026-01-01T00:00:00.000Z",
      dependencies: {},
      peers: {},
    },
  },
});

/**
 * A build's answer as the test reads it: for each file the artifact
 * describes, what it says of it and what came back, the bytes' length and
 * SHA-256, and whether they hold what the package exports, whole and in
 * order. Anything else as it came.
 */
const builtFiles = async (answer: unknown): Promise<unknown> => {
  const built = packageBuildAnswerSchema.safeParse(answer).data;
  if (built === undefined || !built.ok) {
    return answer;
  }
  const { artifact, files } = built;
  return await Promise.all(
    Object.entries(artifact.files).map(async ([path, described]) => {
      const bytes = files[path] ?? new Uint8Array();
      return {
        path,
        described: { bytes: described.bytes, sha256: described.sha256 },
        returned: {
          bytes: bytes.byteLength,
          sha256: await sha256HexOfBytes(bytes),
        },
        holdsExport: decoder.decode(bytes).includes(counted),
      };
    })
  );
};

/** Core's static assets as far as the builder reads them. */
const assetsServing = (
  source: string,
  wasm: ArrayBuffer,
  reads: { builder: number }
): Fetcher => ({
  fetch: async (input, init) => {
    const { pathname } = new URL(new Request(input, init).url);
    if (pathname.endsWith("/package-builder.js")) {
      reads.builder += 1;
      return await Promise.resolve(
        new Response(source, { headers: { "content-type": "text/javascript" } })
      );
    }
    if (pathname.endsWith("/esbuild.wasm")) {
      return await Promise.resolve(
        new Response(wasm, { headers: { "content-type": "application/wasm" } })
      );
    }
    return await Promise.resolve(new Response("Not found", { status: 404 }));
  },
  connect: () => {
    throw new Error("The assets take no connections.");
  },
});

/** A Loader core never reaches on-prem: building here would hold core. */
const noLoader: WorkerLoader = {
  get: () => {
    throw new Error("Core loaded the package builder itself.");
  },
  load: () => {
    throw new Error("Core loaded the package builder itself.");
  },
};

/** How a builder's call ended, as the test reads it. */
const outcomeOf = async (
  run: () => Promise<unknown>
): Promise<Record<string, unknown>> => {
  const started = Date.now();
  try {
    return { status: "ok", value: await run(), ms: Date.now() - started };
  } catch (error) {
    if (error instanceof PlatformBoundError) {
      return {
        status: "bound",
        error: error.message,
        ms: Date.now() - started,
      };
    }
    return {
      status:
        error instanceof SandboxUnavailableError ? "unavailable" : "failed",
      error: error instanceof Error ? error.message : String(error),
      httpStatus:
        error instanceof SandboxUnavailableError
          ? (error.status ?? null)
          : null,
      ms: Date.now() - started,
    };
  }
};

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("core answers");
    }
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === "/app") {
      // An App's call, as core runs one in a session of the App's own.
      return Response.json(
        await outcomeOf(
          async () =>
            await runInSession(env.SANDBOX_HOST, {
              mainModule: "m.js",
              modules: {
                "m.js":
                  'import { WorkerEntrypoint } from "cloudflare:workers";\nexport class E extends WorkerEntrypoint { async go() { return 42; } }',
              },
              entrypoint: "E",
              method: "go",
              args: [],
              cpuMs: 5000,
              wallMs: 10_000,
              owner: "app-stand-in",
            })
        )
      );
    }
    // How often the builder's code was read from the assets.
    const reads = { builder: 0 };
    const builderEnv = {
      ASSETS: assetsServing(
        hostile[searchParams.get("builder") ?? ""] ?? env.PACKAGE_BUILDER,
        env.ESBUILD_WASM,
        reads
      ),
      LOADER: noLoader,
      RUNTIME_PROFILE: env.RUNTIME_PROFILE,
      SANDBOX_DEADLINE_MS: env.SANDBOX_DEADLINE_MS,
      SANDBOX_HOST: env.SANDBOX_HOST,
      SANDBOX_IN_PROCESS: undefined,
    } satisfies PackageBuilderEnv;
    const pkg = await packageOf(searchParams.get("package") ?? "plain");
    if (pathname === "/build") {
      return Response.json(
        await outcomeOf(async () => {
          const builder = await packageBuilder(builderEnv);
          return await builtFiles(
            await builder.build({
              limits: { ...packageLimits, artifactBytes: 2 * 1024 * 1024 },
              lock: lockOf(pkg),
              target: "browser",
              packages: [pkg],
            })
          );
        })
      );
    }
    if (pathname === "/inspect-twice") {
      // Two resolves' inspections, each starting the builder afresh.
      return Response.json(
        await outcomeOf(async () => {
          for (const _ of [1, 2]) {
            // oxlint-disable-next-line no-await-in-loop -- one after the other
            const builder = await packageBuilder(builderEnv);
            // oxlint-disable-next-line no-await-in-loop -- one after the other
            await builder.inspect(packageLimits, [pkg]);
          }
          return reads.builder;
        })
      );
    }
    return Response.json(
      await outcomeOf(async () => {
        const builder = await packageBuilder(builderEnv);
        return await builder.inspect(packageLimits, [pkg]);
      })
    );
  },
} satisfies ExportedHandler<StandInEnv>;
