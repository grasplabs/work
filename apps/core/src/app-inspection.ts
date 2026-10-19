import {
  appCodeFiles,
  appModuleName,
  kitModuleName,
  serverSdkModules,
} from "@grasp-os/compiler";
import type { Diagnostic } from "@grasp-os/compiler";
import {
  generatedPaths,
  readAppManifest,
  serverModuleSource,
  symbolicModules,
} from "@grasp-os/sdk/host";
import type { AppManifest } from "@grasp-os/sdk/host";
import { appManifestMaxBytes } from "@grasp-os/shared/app-limits";
import { versionErrors } from "@grasp-os/shared/app-releases";

import { callSandboxed, SandboxUnavailableError } from "./sandboxed.ts";
import type { SandboxedEnv } from "./sandboxed.ts";
import { buildAppCode, buildKey, checkAppCode } from "./screens.ts";

// Inspecting an App's code of spec 8's layout (spec 8, 16): building it
// and reading its registration in an isolate of its own, never in core.
// Sealing a release does it twice (app-releases.ts); a version's screens
// and a draft's check read the manifest of what they build through it
// (screen-references.ts). It reaches nothing of an App's records, so it
// can serve both without depending on either.

/**
 * The most characters an inspection may answer: an App manifest's bound
 * in bytes, never fewer characters (the host checks the bytes on reading).
 */
const inspectionMaxLength = appManifestMaxBytes;

/** The module that inspects the App in its isolate. */
const inspectModule = "grasp-inspect.js";

/**
 * The inspection isolate's main module: the App's registration as JSON
 * text, through the SDK's runner. Everything in the isolate is
 * untrusted, this module too; it only bounds what it hands back.
 */
const inspectMain = `import { WorkerEntrypoint } from "cloudflare:workers";
import { manifestOfApp } from ${JSON.stringify(kitModuleName("@grasp-os/sdk/runner"))};
import registered from ${JSON.stringify(appModuleName("app.ts"))};

export class Inspect extends WorkerEntrypoint {
  manifest() {
    const text = manifestOfApp(registered);
    if (typeof text !== "string" || text.length > ${inspectionMaxLength}) {
      throw new Error("The App's manifest is too large.");
    }
    return text;
  }
}
`;

/** The most of why App code failed that a refusal keeps. */
const maxFailure = 500;

/** The details of a refused build: where and why, as diagnostics say. */
const buildDetails = (diagnostics: readonly Diagnostic[]) => ({
  diagnostics: diagnostics.slice(0, 50).map(({ file, line, message }) => ({
    file: file ?? null,
    line: line ?? null,
    message: message.slice(0, maxFailure),
  })),
});

/**
 * The App's code in `files` built with the host's generated modules,
 * as modules by flat name; `version.build_failed` with diagnostics if it
 * doesn't build.
 */
export const builtCode = async (
  env: Env,
  files: Readonly<Record<string, string>>,
  /** Whose code it is: the App's ID. */
  app: string,
  /** Given up on: no compile starts, and it throws its reason. */
  signal?: AbortSignal
): Promise<Record<string, string>> => {
  const build = await buildAppCode(env, { ...files }, app, signal);
  signal?.throwIfAborted();
  if (!build.ok) {
    throw versionErrors.create(
      "version.build_failed",
      buildDetails(build.diagnostics)
    );
  }
  return build.modules;
};

/**
 * The App's code in `files`, with the host's real generated modules,
 * built and type-checked against the SDK's server side (`checkAppCode`),
 * as modules by flat name; `version.build_failed` with diagnostics if it
 * doesn't build or check. What a release is sealed from.
 */
export const checkedCode = async (
  env: Env,
  files: Readonly<Record<string, string>>,
  /** Whose code it is: the App's ID. */
  app: string
): Promise<Record<string, string>> => {
  const build = await checkAppCode(env, { ...files }, app);
  if (!build.ok) {
    throw versionErrors.create(
      "version.build_failed",
      buildDetails(build.diagnostics)
    );
  }
  return build.modules;
};

/**
 * What the App's registration answers when `modules` load in an isolate
 * of their own, with the SDK's: its manifest's text, or
 * `version.inspection_failed` with what the App's code threw, or for
 * running past the sandbox's deadline.
 */
export const inspected = async (
  env: SandboxedEnv,
  modules: Readonly<Record<string, string>>,
  sdk: Readonly<Record<string, string>>
): Promise<string> => {
  let text: unknown;
  try {
    // In the sandbox, which bounds its time on either profile (sandboxed.ts).
    text = await callSandboxed(
      env,
      {
        mainModule: inspectModule,
        // The platform's modules last: no App module takes one's name.
        modules: { ...modules, ...sdk, [inspectModule]: inspectMain },
      },
      "Inspect",
      "manifest"
    );
  } catch (error) {
    // The sandbox host down isn't the App's failure.
    if (error instanceof SandboxUnavailableError) {
      throw error;
    }
    throw versionErrors.create("version.inspection_failed", {
      message: (error instanceof Error ? error.message : "").slice(
        0,
        maxFailure
      ),
    });
  }
  if (typeof text !== "string") {
    throw versionErrors.create("version.inspection_failed", {
      message: "The inspection answered something that isn't text.",
    });
  }
  return text;
};

/**
 * The App manifest in `text`, as the host reads it (`readAppManifest`):
 * `version.invalid_manifest` with the SDK's reason for anything else.
 */
export const readManifest = (text: string): AppManifest => {
  try {
    return readAppManifest(text);
  } catch (error) {
    throw versionErrors.create("version.invalid_manifest", {
      message: (error instanceof Error ? error.message : "").slice(
        0,
        maxFailure
      ),
    });
  }
};

/**
 * The manifest of the App whose code `files` holds, inspected with the
 * symbolic references the host lends a first inspection: what it
 * registers, for files no release sealed (a draft, a version not yet
 * made current). Refused as sealing would refuse it.
 */
export const filesManifest = async (
  env: Env,
  files: Readonly<Record<string, string>>,
  /** Whose code it is: the App's ID. */
  app: string,
  /**
   * Given up on (a build job's lease lost): no compile nor inspection
   * starts after, and it throws its reason.
   */
  signal?: AbortSignal
): Promise<AppManifest> => {
  const sdk = await serverSdkModules(env.ASSETS);
  const code = {
    ...appCodeFiles(files),
    ...symbolicModules(),
    [generatedPaths.server]: serverModuleSource,
  };
  // The same code, compiler and SDK register the same: inspected once, its
  // manifest kept in R2 (in the EU) as the builds are, so saving or
  // checking the same server code again runs nothing in the sandbox. Only
  // a manifest that read is kept; a failure inspects again next time.
  const cacheKey = `inspections/${await buildKey(code)}/${sdk.version}.json`;
  const cached = await env.FILES.get(cacheKey);
  if (cached) {
    return readManifest(await cached.text());
  }
  signal?.throwIfAborted();
  const symbolic = await builtCode(env, code, app, signal);
  signal?.throwIfAborted();
  const text = await inspected(env, symbolic, sdk.modules);
  const manifest = readManifest(text);
  await env.FILES.put(cacheKey, text);
  return manifest;
};
