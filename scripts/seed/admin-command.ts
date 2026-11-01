/**
 * Grasp's admin steering the local stack's onboarding, for the seeds and
 * the lab: a command delivered as the admin delivers it (apps/admin's
 * src/clients/commands.ts), and the snapshot it reads back, each signed
 * with the key derived from the local core's auth secret, which
 * `.dev.vars` holds, for that purpose alone. A local stack takes them
 * without the router's secret. Nothing but core on this machine is asked.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  adminCommandPath,
  adminCommandPurpose,
} from "@grasp-os/shared/admin-command";
import type { AdminCommand } from "@grasp-os/shared/admin-command";
import {
  adminSnapshotPath,
  adminSnapshotPurpose,
  adminSnapshotSchema,
} from "@grasp-os/shared/admin-snapshot";
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";

/** Core as `vp run dev` runs it. */
const localCore = "http://localhost:8787";

/** Where the local core's secrets are. */
const devVars = path.resolve(import.meta.dirname, "../../apps/core/.dev.vars");

/** The staff member Access would have let into the admin. */
const localStaffEmail = "staff@grasp.test";

/** The local core's auth secret, from its `.dev.vars`. */
const localAuthSecret = async (): Promise<string> => {
  const vars = await readFile(devVars, "utf-8");
  const line = vars
    .split("\n")
    .find((each) => each.startsWith("BETTER_AUTH_SECRET="));
  const secret = line?.slice("BETTER_AUTH_SECRET=".length).trim() ?? "";
  if (secret === "") {
    throw new Error(`No BETTER_AUTH_SECRET in ${devVars}`);
  }
  return secret.replaceAll(/^"|"$/gu, "");
};

/** Posts `body` to `apiPath` on the local core, signed for `purpose`. */
const signedPost = async (
  apiPath: string,
  purpose: string,
  body: string
): Promise<Response> => {
  const key = await hkdfHmacKey(await localAuthSecret(), purpose, ["sign"]);
  const signature = toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
  return await fetch(`${localCore}${apiPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [platformUpdateSignatureHeader]: signature,
    },
    body,
  });
};

/** Gives `command` to the local stack's onboarding as `staffEmail`; throws when core doesn't apply it. */
export const adminCommand = async (
  command: AdminCommand,
  staffEmail = localStaffEmail
): Promise<void> => {
  const response = await signedPost(
    adminCommandPath,
    adminCommandPurpose,
    JSON.stringify({
      id: randomUUID(),
      ...command,
      staff: { email: staffEmail },
      issuedAt: new Date().toISOString(),
    })
  );
  if (!response.ok) {
    throw new Error(
      `${command.type} wasn't applied (${response.status}): ${await response.text()}`
    );
  }
  await response.body?.cancel();
};

/** The local stack's onboarding as the admin reads it. */
export const adminSnapshot = async (): Promise<AdminSnapshot> => {
  const response = await signedPost(
    adminSnapshotPath,
    adminSnapshotPurpose,
    JSON.stringify({
      sentAt: new Date().toISOString(),
      staff: { email: localStaffEmail },
    })
  );
  if (!response.ok) {
    throw new Error(`The snapshot wasn't read (${response.status})`);
  }
  return adminSnapshotSchema.parse(await response.json());
};
