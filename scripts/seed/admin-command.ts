/**
 * A command to the local stack's onboarding, as Grasp's admin delivers it
 * (apps/admin's src/clients/commands.ts): signed with the key derived from
 * the local core's auth secret, which `.dev.vars` holds, for commands
 * alone. A local stack takes it without the router's secret. For the
 * seeds and the lab only: nothing but core on this machine is asked.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  adminCommandPath,
  adminCommandPurpose,
} from "@grasp-os/shared/admin-command";
import type { AdminCommand } from "@grasp-os/shared/admin-command";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";

/** Core as `vp run dev` runs it. */
const localCore = "http://localhost:8787";

/** Where the local core's secrets are. */
const devVars = path.resolve(import.meta.dirname, "../../apps/core/.dev.vars");

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

/** Gives `command` to the local stack's onboarding as `staffEmail`; throws when core doesn't apply it. */
export const adminCommand = async (
  command: AdminCommand,
  staffEmail = "staff@grasp.test"
): Promise<void> => {
  const body = JSON.stringify({
    id: randomUUID(),
    ...command,
    staff: { email: staffEmail },
    issuedAt: new Date().toISOString(),
  });
  const key = await hkdfHmacKey(await localAuthSecret(), adminCommandPurpose, [
    "sign",
  ]);
  const signature = toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
  const response = await fetch(`${localCore}${adminCommandPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [platformUpdateSignatureHeader]: signature,
    },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `${command.type} wasn't applied (${response.status}): ${await response.text()}`
    );
  }
  await response.body?.cancel();
};
