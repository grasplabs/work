/**
 * Grasp's admin steering the stack's onboarding, for end-to-end tests: a
 * command delivered as the admin delivers it (apps/admin's
 * src/clients/commands.ts), and the snapshot it reads back, each signed
 * with the key the admin derives from the stack's auth secret for that
 * purpose alone. A local stack takes them without the router's secret.
 */
import { randomUUID } from "node:crypto";

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

import { testAuthSecret } from "./people.ts";
import { origin } from "./stack.ts";

/** The staff member Access would have let into the admin. */
const staffEmail = "e2e-staff@grasp.test";

/** Posts `body` to `path` on the stack's core, signed for `purpose`. */
const signedPost = async (
  path: string,
  purpose: string,
  body: string
): Promise<Response> => {
  const key = await hkdfHmacKey(testAuthSecret, purpose, ["sign"]);
  const signature = toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
  return await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [platformUpdateSignatureHeader]: signature,
    },
    body,
  });
};

/** Gives `command` to the stack's onboarding, as the admin does; throws when core doesn't apply it. */
export const adminCommand = async (command: AdminCommand): Promise<void> => {
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

/** The stack's onboarding as the admin reads it. */
export const adminSnapshot = async (): Promise<AdminSnapshot> => {
  const response = await signedPost(
    adminSnapshotPath,
    adminSnapshotPurpose,
    JSON.stringify({
      sentAt: new Date().toISOString(),
      staff: { email: staffEmail },
    })
  );
  if (!response.ok) {
    throw new Error(`The snapshot wasn't read (${response.status})`);
  }
  return adminSnapshotSchema.parse(await response.json());
};
