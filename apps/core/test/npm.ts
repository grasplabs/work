/**
 * The npm registry in core's tests: connect's strict fake of it
 * (connect's test/npm-registry-fake.ts) runs in the Worker that stands in
 * for the internet behind the real connect (test/connect-providers.ts).
 * Tests publish packages on it, with names of their own, and resolve and
 * build them through core's real path.
 */
import { toBase64 } from "@grasp-os/shared/encoding";
import type { DependencyIntent } from "@grasp-os/shared/packages";
import { expect } from "vite-plus/test";
import { z } from "zod";

import type { NpmRegistryFake } from "../../connect/test/npm-registry-fake.ts";
import { npmAskedUrl, npmPublishUrl } from "./connect-providers.ts";
import { unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

/** One version as the fake registry publishes it. */
export type Published = Parameters<NpmRegistryFake["publish"]>[0];

/** A tarball's entries, hand-made. */
export type Entries = NonNullable<Published["entries"]>;

const day = 24 * 60 * 60 * 1000;

/** `days` days ago, as the registry writes a time. */
export const daysAgo = (days: number): string =>
  new Date(Date.now() - days * day).toISOString();

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** Publishes a version on the fake registry; returns the integrity it names. */
export const publish = async (published: Published): Promise<string> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  const response = await providers.fetch(npmPublishUrl, {
    method: "POST",
    body: JSON.stringify(published),
  });
  return z.object({ integrity: z.string() }).parse(await response.json())
    .integrity;
};

/** The paths the fake registry was asked for so far, in order. */
export const askedPaths = async (): Promise<string[]> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  const response = await providers.fetch(npmAskedUrl);
  return z.array(z.string()).parse(await response.json());
};

/** A package name no other test publishes. */
export const named = (base: string): string => `${base}-${unique()}`;

/** A plain package: an ES module and its package.json. */
export const plain = (
  name: string,
  version = "1.0.0",
  manifest: Record<string, unknown> = {}
): Published => ({
  name,
  version,
  manifest: { type: "module", main: "index.js", license: "MIT", ...manifest },
  files: { "index.js": `export const name = ${JSON.stringify(name)};` },
});

/** `length` characters of random base64: text gzip barely shrinks. */
export const noise = (length: number): string => {
  let text = "";
  while (text.length < length) {
    text += toBase64(crypto.getRandomValues(new Uint8Array(3072)));
  }
  return text.slice(0, length);
};

/** What an App's package.json asks for, for `app`. */
export const intentFor = (
  app: string,
  dependencies: Record<string, string>,
  more: Partial<DependencyIntent> = {}
): DependencyIntent => ({
  app,
  sourceRevision: "rev-1",
  purpose: "Format dates in the report.",
  targets: ["browser"],
  dependencies,
  ...more,
});

/** Why a call failed: its code and details. */
export const failure = async (
  promise: Promise<unknown>
): Promise<{ code: string; details: Record<string, unknown> }> => {
  try {
    await promise;
  } catch (error) {
    const parsed = z
      .object({
        code: z.string(),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .safeParse(error);
    if (parsed.success) {
      return { code: parsed.data.code, details: parsed.data.details ?? {} };
    }
    throw error;
  }
  throw new Error("It succeeded");
};

/** The refusals of a failed resolve or build, each `name@version: reason`. */
export const refusalsOf = async (
  promise: Promise<unknown>
): Promise<string[]> => {
  const { code, details } = await failure(promise);
  expect(code).toBe("package.refused");
  return z.array(z.string()).parse(details.refusals);
};

/** One package whose tarball is `entries`, as the registry serves it. */
export const crafted = async (
  entries: (name: string) => Entries
): Promise<string> => {
  const name = named("crafted");
  await publish({ name, version: "1.0.0", entries: entries(name) });
  return name;
};

/** A tarball's package.json entry. */
export const manifestEntry = (
  name: string,
  more: Record<string, unknown> = {}
) => ({
  path: "package/package.json",
  content: JSON.stringify({ name, version: "1.0.0", ...more }),
});
