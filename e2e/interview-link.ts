/**
 * Someone's own interview link, for end-to-end tests. A link reaches its
 * person by mail, which a local stack doesn't send, and nothing hands it
 * to anyone else: core keeps only a random id per person and makes the
 * secret from it with its own key (apps/core/src/onboarding/link-secret.ts).
 * So this reads the id straight from the stack's local state, as
 * connections-seed.ts writes there, and makes the secret the same way,
 * from the stack's auth secret.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toBase64Url } from "@grasp-os/shared/encoding";
import { interviewPagePath } from "@grasp-os/shared/interview-links";

import { testAuthSecret } from "./people.ts";
import { stateDir } from "./stack.ts";

/** What link-secret.ts derives a link's secret for. */
const linkPurpose = "grasp-os onboarding link";

/** The onboarding store's databases in the stack's local state. */
const storeFiles = async (): Promise<string[]> => {
  const root = path.join(stateDir, "v3", "do");
  const all = await readdir(root);
  const folders = all.filter((name) => name.endsWith("-Onboarding"));
  const files = await Promise.all(
    folders.map(async (folder) => {
      const names = await readdir(path.join(root, folder));
      return names
        .filter((name) => name.endsWith(".sqlite"))
        .map((name) => path.join(root, folder, name));
    })
  );
  return files.flat();
};

/**
 * The random id behind `person`'s link, if they have one. A file without
 * the store's tables is passed over: the folder also holds Miniflare's
 * `metadata.sqlite`.
 */
const linkIdOf = (file: string, person: string): string | undefined => {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const hasCodes =
      database
        .prepare(
          "select 1 from sqlite_master where type = 'table' and name = 'link_codes'"
        )
        .get() !== undefined;
    if (!hasCodes) {
      return undefined;
    }
    const row = database
      .prepare("select link_id from link_codes where person = ?")
      .get(person);
    const id = row?.link_id;
    return typeof id === "string" ? id : undefined;
  } finally {
    database.close();
  }
};

/** The secret core makes from a link's id. */
const secretOf = async (linkId: string): Promise<string> => {
  const key = await hkdfHmacKey(testAuthSecret, linkPurpose, ["sign"]);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(linkId)
  );
  return toBase64Url(new Uint8Array(mac));
};

/** The path of `person`'s own link, its secret after the `#`. */
export const interviewLinkOf = async (person: string): Promise<string> => {
  const files = await storeFiles();
  const linkId = files
    .map((file) => linkIdOf(file, person))
    .find((id) => id !== undefined);
  if (linkId === undefined) {
    throw new Error(`No interview link for ${person} in the stack's state`);
  }
  return `${interviewPagePath}#${await secretOf(linkId)}`;
};
