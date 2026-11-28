/**
 * What `scripts/app-kit-sync.ts` compares: the App kit's files that the
 * registry's CLI writes, each against the hash of what the CLI wrote
 * (`packages/app-kit/registry.json`), and the files changed on purpose
 * (`packages/app-kit/local-changes.json`). Pure, so its tests need no
 * registry and no network.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

/** The pin: the style and CLI the files were installed with, and each file's hash. */
export const registryPinSchema = z.object({
  style: z.string().min(1),
  cli: z.string().min(1),
  /** Where the registry says which style is its default, read on `installed`. */
  defaultStyleSource: z.url(),
  installed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  /** By path from packages/app-kit: the SHA-256 of the file the CLI wrote. */
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/u)),
  /**
   * The kit's own files where the CLI writes (the parts bound to the SDK
   * and what they share), by path from packages/app-kit.
   */
  own: z.array(z.string().min(1)),
});

export type RegistryPin = z.infer<typeof registryPinSchema>;

/** A file changed on purpose: where, and why, in one line. */
export const localChangeSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
  /** The test that holds the change, by path from the repository's root. */
  test: z.string().min(1),
});

export type LocalChange = z.infer<typeof localChangeSchema>;

export const localChangesSchema = z.array(localChangeSchema);

/** A file's SHA-256, as the pin keeps it. */
export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * What breaks the rule "the kit is the registry's, but for the listed
 * changes", given each pinned file's current bytes (`undefined`: gone):
 * a file that differs and isn't listed, a listed one that no longer
 * differs or is neither pinned nor the kit's own, a pinned file that is missing, and a
 * file in the CLI's folders that is neither pinned nor the kit's own.
 */
export const problemsOf = (
  pin: RegistryPin,
  changes: readonly LocalChange[],
  read: (file: string) => Uint8Array | undefined,
  /** Every file under the folders the CLI writes to, by path from packages/app-kit. */
  present: readonly string[]
): string[] => {
  const listed = new Map(changes.map((change) => [change.path, change]));
  const own = new Set(pin.own);
  const problems: string[] = present
    .filter((file) => !Object.hasOwn(pin.files, file) && !own.has(file))
    .map(
      (file) =>
        `${file} is neither a file the registry installs nor one of the kit's own (registry.json \`own\`).`
    );
  for (const [file, hash] of Object.entries(pin.files)) {
    const bytes = read(file);
    if (bytes === undefined) {
      problems.push(`${file} is pinned but missing.`);
      continue;
    }
    const same = sha256(bytes) === hash;
    if (!same && !listed.has(file)) {
      problems.push(
        `${file} differs from what the registry installs and isn't in local-changes.json: undo the change, or list it with its reason and test.`
      );
    }
    if (same && listed.has(file)) {
      problems.push(
        `${file} is listed in local-changes.json but no longer differs: drop its entry.`
      );
    }
  }
  // An own file copied from upstream (the Markdown) lists its changes
  // too, though no pin holds what it was.
  for (const file of listed.keys()) {
    if (!Object.hasOwn(pin.files, file) && !own.has(file)) {
      problems.push(
        `${file} is listed in local-changes.json but is neither a file the registry installs nor one of the kit's own.`
      );
    }
  }
  return problems;
};
