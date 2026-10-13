import { kickoffErrors } from "@grasp-os/shared/kickoff";
import { uploadErrors, uploadTypes } from "@grasp-os/shared/uploads";
import { unzipSync, zipSync } from "fflate";

import {
  ExtractorUnavailableError,
  localExtractor,
} from "../../src/knowledge/extract.ts";
import type { LocalExtractorEnv } from "../../src/knowledge/extract.ts";
import { extractorAsset } from "../../src/knowledge/extractor/asset.ts";
import { transcriptOf } from "../../src/onboarding/kickoff.ts";

// Extracting an upload's text on plain workerd
// (scripts/workerd-sandbox-extraction.test.ts): the same `localExtractor`
// an upload, a shared document and a kickoff's transcript run, with
// `SANDBOX_HOST` bound to the sandbox supervisor as on-prem binds it. The
// extractor's module is the one core's build makes, given as the static
// assets give it, or one a file that took it over would run instead.

interface StandInEnv {
  SANDBOX_HOST: Fetcher;
  RUNTIME_PROFILE: string;
  SANDBOX_DEADLINE_MS?: string;
  /** The extractor core's build makes (build-extractor.ts). */
  EXTRACTOR: string;
}

/** An extractor's module of `body`: what a file that took it over runs. */
const takenOver = (body: string): string =>
  `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async extractRead(mediaType, size, read) { ${body} }
}`;

/** What a file that took the extractor over could run, by name. */
const hostile: Readonly<Record<string, string>> = {
  // Never returns.
  busy: takenOver("for (;;) {}"),
  // Allocates without end while a read of the file is in flight.
  memory: takenOver(`const first = await read(0);
    read(first.byteLength);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const held = [];
    for (;;) {
      held.push(new Uint8Array(16 * 1024 * 1024).fill(1));
      const until = Date.now() + 20;
      while (Date.now() < until) {}
    }`),
  // Answers more than a session's message takes.
  oversized: takenOver(
    'return { ok: true, markdown: "x".repeat(15_000_000) };'
  ),
  // Reads the file's start again.
  reread: takenOver(`await read(0);
    try {
      await read(0);
      return { ok: true, markdown: "# Read twice" };
    } catch {
      return { ok: true, markdown: "# Refused" };
    }`),
};

/** Core's static assets as far as extracting reads them: the extractor. */
const assetsServing = (source: string): Fetcher => ({
  fetch: async (input, init) =>
    await Promise.resolve(
      new URL(new Request(input, init).url).pathname === `/${extractorAsset}`
        ? new Response(source, {
            headers: { "content-type": "text/javascript" },
          })
        : new Response("Not found", { status: 404 })
    ),
  connect: () => {
    throw new Error("The assets take no connections.");
  },
});

/**
 * A Word file with `bytes` of noise beside its parts, stored as they are:
 * a file the extractor reads in many chunks, whose central directory, at
 * its end, only a whole and ordered read finds.
 */
const padded = (docx: Uint8Array, bytes: number): Uint8Array<ArrayBuffer> => {
  const noise = new Uint8Array(bytes);
  // 64 KiB at a time: as much as getRandomValues fills at once.
  for (let at = 0; at < bytes; at += 65_536) {
    crypto.getRandomValues(noise.subarray(at, at + 65_536));
  }
  return new Uint8Array(
    zipSync({ ...unzipSync(docx), "noise.bin": noise }, { level: 0 })
  );
};

/** A Loader core never reaches on-prem: extracting here would hold core. */
const noLoader: WorkerLoader = {
  get: () => {
    throw new Error("Core loaded the extractor itself.");
  },
  load: () => {
    throw new Error("Core loaded the extractor itself.");
  },
};

/** How an extraction ended, as the test reads it. */
const outcomeOf = async (
  extract: () => Promise<string>
): Promise<Record<string, unknown>> => {
  const started = Date.now();
  try {
    const text = await extract();
    return { status: "ok", text, ms: Date.now() - started };
  } catch (error) {
    const code = uploadErrors.codeOf(error) ?? kickoffErrors.codeOf(error);
    if (code !== undefined) {
      return { status: "failed", code, ms: Date.now() - started };
    }
    const cause =
      error instanceof Error && error.cause instanceof Error
        ? `${error.cause.name}: ${error.cause.message}`
        : null;
    return {
      status: "unavailable",
      error: error instanceof Error ? error.name : String(error),
      busy: error instanceof ExtractorUnavailableError && error.busy,
      cause,
      ms: Date.now() - started,
    };
  }
};

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);
    if (request.method !== "POST") {
      return new Response("core answers");
    }
    const posted = new Uint8Array(await request.arrayBuffer());
    const pad = Number(searchParams.get("pad") ?? 0);
    const bytes = pad > 0 ? padded(posted, pad) : posted;
    const extractorEnv = {
      ASSETS: assetsServing(
        hostile[searchParams.get("extractor") ?? ""] ?? env.EXTRACTOR
      ),
      RUNTIME_PROFILE: env.RUNTIME_PROFILE,
      SANDBOX_DEADLINE_MS: env.SANDBOX_DEADLINE_MS,
      // As a deployment off Cloudflare that forgot its sandbox.
      SANDBOX_HOST: searchParams.has("unbound") ? undefined : env.SANDBOX_HOST,
      SANDBOX_IN_PROCESS: undefined,
    } satisfies Omit<LocalExtractorEnv, "LOADER">;
    if (pathname === "/transcript") {
      return Response.json(
        await outcomeOf(async () => {
          // A stand-in's env: no Loader, which nothing here may reach.
          const { text } = await transcriptOf(
            { ...extractorEnv, LOADER: noLoader },
            { file: { name: "kickoff.docx", bytes } }
          );
          return text;
        })
      );
    }
    const mediaType = searchParams.get("type");
    if (
      mediaType !== uploadTypes.pdf &&
      mediaType !== uploadTypes.docx &&
      mediaType !== uploadTypes.xlsx
    ) {
      return new Response("Which type?", { status: 400 });
    }
    return Response.json(
      await outcomeOf(
        async () =>
          await localExtractor({ ...extractorEnv, LOADER: noLoader })({
            name: "upload",
            mediaType,
            bytes,
          })
      )
    );
  },
} satisfies ExportedHandler<StandInEnv>;
