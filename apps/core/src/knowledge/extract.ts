import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { log } from "@grasp-os/shared/log";
import { isolateBase } from "@grasp-os/shared/runtime";
import { uploadErrors } from "@grasp-os/shared/uploads";
import type { UploadMediaType } from "@grasp-os/shared/uploads";
import { z } from "zod";

import { deploymentStaysInEu } from "../models.ts";
import type { ModelsEnv } from "../models.ts";
import {
  functionCapability,
  runInSession,
  sandboxVerdictOf,
} from "../sandbox-session.ts";
import { sessionHost } from "../sandboxed.ts";
import { extractorAsset } from "./extractor/asset.ts";
import type ExtractorWorker from "./extractor/worker.ts";

// Extracting an uploaded file's text as Markdown, by one of two
// extractors, which `extractorFor` picks:
//
// - Workers AI's document conversion (`toMarkdown`, over the AI binding)
//   for a file in a normal collection. Cloudflare documents converting
//   PDF, Word and Excel files as free, running no model (only images go
//   through models, and images can't be uploaded), so it isn't a model
//   call and doesn't go through the model gateway; but it sends the file
//   out of the Worker, to a service that isn't pinned to the EU.
// - The local extractor for a file in a sensitive collection (the flag the
//   gateway's data rule reads too), for every file of a deployment whose
//   config keeps everything in the EU, and wherever there is no AI binding
//   (plain workerd, on-prem). So a sensitive file's content never leaves
//   the deployment's own Workers.
//
// The local extractor (extractor/worker.ts, with the parsers in
// extractor/formats.ts) never runs in core's isolate: core starts a
// Dynamic Worker for each extraction, with its code from core's static
// assets (build-extractor.ts), no bindings, no network and a CPU limit,
// and calls it over RPC. A file crafted to exhaust a parser (a PDF whose
// one stream inflates to gigabytes, an archive of millions of tags) kills
// that isolate, and the upload fails for good as `upload.too_complex`;
// core, and whatever else it runs, carry on.
//
// That holds where the runtime enforces the isolate's CPU limit. Plain
// workerd (on-prem) ignores `cpuMs` and runs a process's requests on one
// thread, so a Dynamic Worker core loads itself there holds all of core
// while a parser spins. Threat model on-prem, and how each is closed:
// - A file exhausts a parser (CPU or memory), or takes it over and loops.
//   With `SANDBOX_HOST` bound, the extraction runs on the sandbox host in
//   a session (sandbox-session.ts), as App code does: the supervisor kills
//   its process past `extractorCpuMs` of CPU time, its memory cap or
//   `extractorWallMs`, and the upload fails as `upload.too_complex`.
//   Chosen over bounding it here (a size limit doesn't bound how long
//   pdf.js may spin on a small file, and workerd has no worker threads)
//   and over a mechanism of its own: the session already bounds an
//   untrusted isolate's time, memory and answer.
// - Extractions take every sandbox process, starving Apps (or Apps starve
//   uploads). They run as one owner of their own, `platform:extractor`,
//   which the supervisor holds to its per-owner share of the pool like any
//   App; past it the extraction is busy and retried, never failed.
// - A deployment off Cloudflare forgets `SANDBOX_HOST`, and parsers run in
//   core unbounded again. Refused, as `sessionHost` refuses App code (the
//   extractor unavailable, retried and then failed), unless the
//   deployment accepts it with `SANDBOX_IN_PROCESS=unbounded`.
// - The extractor's answer is the file's doing: checked here whichever
//   way it ran (`extractedSchema`, `markdownMaxBytes`).

/** A file to extract: its name, its type (by its extension) and itself. */
export interface ExtractInput {
  name: string;
  mediaType: UploadMediaType;
  bytes: Uint8Array;
}

/**
 * Turns a file into Markdown. Throws an expected error for what no retry
 * changes (`upload.too_complex`, `knowledge.too_large`),
 * `ExtractorUnavailableError` when it couldn't try, and any other error
 * when it couldn't read the file.
 */
export type Extractor = (file: ExtractInput) => Promise<string>;

/**
 * The extractor couldn't be reached, or failed for a moment, before it
 * read the file: trying again may work.
 */
export class ExtractorUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("The extractor couldn't be reached", options);
    this.name = "ExtractorUnavailableError";
  }
}

/**
 * How the extractor's isolate runs: no bindings, no importable env, no
 * network (`globalOutbound: null` and no subrequests), and at most 20 s of
 * CPU, many times what a large document takes. `nodejs_compat` is for
 * pdf.js, which reaches for Node's built-ins.
 */
const isolateSettings = {
  ...isolateBase,
  compatibilityFlags: [...isolateBase.compatibilityFlags, "nodejs_compat"],
  env: {},
  globalOutbound: null,
  limits: { cpuMs: 20_000, subRequests: 0 },
} satisfies Omit<WorkerLoaderWorkerCode, "mainModule" | "modules">;

/**
 * How the runtime says it stopped an isolate over its limits: "Worker
 * exceeded CPU time limit." or "… memory limit."
 */
const overLimit = /exceeded (?:its )?(?:CPU|memory)/iu;

/**
 * The extractor's module, from core's static assets. They answer unknown
 * paths with the frontend's index.html, so anything but JavaScript means
 * it is missing: a deployment built without it.
 */
const extractorSource = async (assets: Fetcher): Promise<string> => {
  const response = await assets.fetch(`https://assets/${extractorAsset}`);
  const type = response.headers.get("content-type") ?? "";
  if (!(response.ok && type.includes("javascript"))) {
    // A deployment built without it (build-extractor.ts): nothing about
    // the file, so retried, and failed as unexpected once retries run out.
    log.error("extractor.missing", { status: response.status });
    throw new ExtractorUnavailableError();
  }
  return await response.text();
};

/**
 * The most Markdown core takes from the sandbox, in bytes of UTF-8: a
 * document's limit (documents.ts). Checked here, whatever the sandbox
 * says of itself.
 */
const markdownMaxBytes = 1024 * 1024;

/**
 * What the sandbox may answer. Its code is core's, but it runs what it was
 * handed, so its answer is checked like any other input.
 */
const extractedSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), markdown: z.string() }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum(["unreadable", "too_large"]),
  }),
]);

/**
 * The extractor's module, read once per isolate from each assets binding:
 * it is the release's, as the static assets are. Only a module read is
 * kept, never a failure.
 */
const sources = new WeakMap<Fetcher, string>();

const cachedSource = async (assets: Fetcher): Promise<string> => {
  const source = sources.get(assets) ?? (await extractorSource(assets));
  sources.set(assets, source);
  return source;
};

/** What extracting runs as on the sandbox host: an owner of its own. */
const extractorOwner = "platform:extractor";

/** The CPU time an extraction may use: the isolate's limit on Cloudflare. */
const extractorCpuMs = isolateSettings.limits.cpuMs;

/**
 * The wall-clock time an extraction may take on the sandbox host, the
 * file's reads included: well past its CPU time, which bounds the work.
 */
const extractorWallMs = 60_000;

/** The wall-clock time: {@link extractorWallMs}, or less where tests set it. */
const wallMsOf = (env: Pick<Env, "SANDBOX_DEADLINE_MS">): number => {
  const set = Number(env.SANDBOX_DEADLINE_MS);
  return Number.isInteger(set) && set > 0 && set < extractorWallMs
    ? set
    : extractorWallMs;
};

/**
 * How much of the file the sandbox host's isolate reads at a time: well
 * within a session's message once Cap'n Web has encoded it.
 */
const readChunkBytes = 1024 * 1024;

/**
 * The supervisor's verdicts that say the file made the extractor run too
 * long, use too much, crash or answer too much (sandbox-session.ts): no
 * retry changes them. Any other (`busy` above all) means it couldn't try.
 */
const fileVerdicts = new Set([
  "deadline",
  "cpu",
  "memory",
  "crashed",
  "refused",
]);

/** What the extractor answers in a Dynamic Worker of core's own. */
const extractedInCore = async (
  loader: WorkerLoader,
  source: string,
  { mediaType, bytes }: Pick<ExtractInput, "mediaType" | "bytes">
): Promise<unknown> => {
  const worker = loader.load({
    ...isolateSettings,
    mainModule: "extractor.js",
    modules: { "extractor.js": source },
  });
  try {
    return await worker
      .getEntrypoint<ExtractorWorker>()
      .extract({ mediaType, bytes });
  } catch (error) {
    if (error instanceof Error && overLimit.test(error.message)) {
      throw uploadErrors.create("upload.too_complex");
    }
    throw new ExtractorUnavailableError({ cause: error });
  }
};

/** What the extractor answers on the sandbox host, in a session. */
const extractedOnHost = async (
  host: Fetcher,
  wallMs: number,
  source: string,
  { mediaType, bytes }: Pick<ExtractInput, "mediaType" | "bytes">
): Promise<unknown> => {
  // The isolate asks for the file a chunk at a time, from where it is.
  const read = (offset: unknown): Uint8Array => {
    if (
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset >= bytes.byteLength
    ) {
      throw new RangeError("There is nothing of the file to read there.");
    }
    return bytes.slice(offset, offset + readChunkBytes);
  };
  try {
    return await runInSession(host, {
      mainModule: "extractor.js",
      modules: { "extractor.js": source },
      entrypoint: "default",
      method: "extractRead",
      args: [
        { value: mediaType },
        { value: bytes.byteLength },
        { capability: functionCapability(read) },
      ],
      cpuMs: extractorCpuMs,
      wallMs,
      owner: extractorOwner,
    });
  } catch (error) {
    const verdict = sandboxVerdictOf(error);
    if (verdict !== undefined && fileVerdicts.has(verdict)) {
      throw uploadErrors.create("upload.too_complex");
    }
    throw new ExtractorUnavailableError({ cause: error });
  }
};

/** What `localExtractor` reads from core's env. */
export type LocalExtractorEnv = Pick<
  Env,
  | "ASSETS"
  | "LOADER"
  | "RUNTIME_PROFILE"
  | "SANDBOX_DEADLINE_MS"
  | "SANDBOX_HOST"
  | "SANDBOX_IN_PROCESS"
>;

/**
 * Extracts in a fresh sandbox, whatever the file's collection: on the
 * sandbox host where `SANDBOX_HOST` is bound, otherwise in a Dynamic
 * Worker of core's own, only where the runtime bounds its CPU or the
 * deployment accepts that nothing does (`sessionHost`).
 */
export const localExtractor =
  (env: LocalExtractorEnv): Extractor =>
  async ({ mediaType, bytes }) => {
    let host: Fetcher | undefined;
    try {
      host = sessionHost(env);
    } catch (error) {
      // Nothing bounds a parser here: none starts.
      log.error("extractor.unbounded", {});
      throw new ExtractorUnavailableError({ cause: error });
    }
    const source = await cachedSource(env.ASSETS);
    const answer =
      host === undefined
        ? await extractedInCore(env.LOADER, source, { mediaType, bytes })
        : await extractedOnHost(host, wallMsOf(env), source, {
            mediaType,
            bytes,
          });
    const parsed = extractedSchema.safeParse(answer);
    if (!parsed.success) {
      throw new Error("The extractor answered what it may not");
    }
    const extracted = parsed.data;
    if (
      extracted.ok &&
      new TextEncoder().encode(extracted.markdown).byteLength <=
        markdownMaxBytes
    ) {
      return extracted.markdown;
    }
    if (extracted.ok || extracted.reason === "too_large") {
      throw knowledgeErrors.create("knowledge.too_large");
    }
    throw new Error("The extractor couldn't read the file");
  };

/** Workers AI's document conversion, over the AI binding. */
const workersAiExtractor =
  (ai: Ai): Extractor =>
  async ({ name, mediaType, bytes }) => {
    let converted: ConversionResponse;
    try {
      converted = await ai.toMarkdown({
        name,
        blob: new Blob([new Uint8Array(bytes)], { type: mediaType }),
      });
    } catch (error) {
      throw new ExtractorUnavailableError({ cause: error });
    }
    if (converted.format === "error") {
      throw new Error("Workers AI couldn't convert the file");
    }
    return converted.data;
  };

/** Which extractor an upload got, as its audit events name it. */
export type ExtractorName = "workers-ai" | "local";

/**
 * The extractor for a file in `collection`: Workers AI's conversion for a
 * normal collection; the local one for a sensitive collection, for a
 * deployment whose config keeps everything in the EU, and without an AI
 * binding (on-prem).
 */
export const extractorFor = (
  env: Omit<ModelsEnv, "AI"> & { AI?: Ai } & LocalExtractorEnv,
  collection: { sensitive: boolean }
): { name: ExtractorName; extract: Extractor } => {
  const ai = env.AI;
  if (
    collection.sensitive ||
    deploymentStaysInEu(env) ||
    typeof ai?.toMarkdown !== "function"
  ) {
    return { name: "local", extract: localExtractor(env) };
  }
  return { name: "workers-ai", extract: workersAiExtractor(ai) };
};
