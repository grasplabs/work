import {
  adminCommandAnswerSchema,
  adminCommandPath,
  adminCommandPurpose,
} from "@grasp-os/shared/admin-command";
import type {
  AdminCommand,
  AdminCommandAnswer,
  AdminCommandEnvelopeInput,
} from "@grasp-os/shared/admin-command";
import {
  adminSnapshotPath,
  adminSnapshotPurpose,
  adminSnapshotSchema,
} from "@grasp-os/shared/admin-snapshot";
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import type { OrgRules } from "@grasp-os/shared/admin/onboarding-admin";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import type { Agreements } from "@grasp-os/shared/onboarding";
import type { GateThreshold } from "@grasp-os/shared/onboarding-gate";
import type { StephenSetup } from "@grasp-os/shared/onboarding-staff";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { routed } from "./sign-in.ts";

// Commands from Grasp's admin as the admin delivers them (src/admin-command.ts):
// an envelope signed with this company's key for commands, posted through
// the router, as the staff member Access let in.

/** The staff member the tests' commands come from. */
export const commandStaff = "grace.hopper@grasp.test";

/** `body`'s signature as the admin makes it, with the key `secret` gives for `purpose`. */
export const commandSignature = async (
  body: string,
  secret = env.BETTER_AUTH_SECRET,
  purpose = adminCommandPurpose
): Promise<string> => {
  const key = await hkdfHmacKey(secret, purpose, ["sign"]);
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
};

/** `command` in its envelope: a new id, issued now, by `commandStaff`, unless told otherwise. */
export const envelopeOf = (
  command: AdminCommand,
  {
    id = crypto.randomUUID(),
    issuedAt = new Date().toISOString(),
  }: { id?: string; issuedAt?: string } = {}
): AdminCommandEnvelopeInput => ({
  id,
  ...command,
  staff: { email: commandStaff },
  issuedAt,
});

/** Posts `body` to core through the router, signed with `signature` (none for null). */
export const postCommand = async (
  body: string,
  {
    signature = null,
    method = "POST",
    coreEnv = env,
  }: { signature?: string | null; method?: string; coreEnv?: Env } = {}
): Promise<Response> => {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) {
    headers.set(platformUpdateSignatureHeader, signature);
  }
  return await routed(
    adminCommandPath,
    { method, headers, ...(method === "POST" ? { body } : {}) },
    coreEnv
  );
};

/** Delivers `envelope` as the admin does: signed with this company's key. */
export const deliver = async (
  envelope: AdminCommandEnvelopeInput,
  coreEnv: Env = env
): Promise<Response> => {
  const body = JSON.stringify(envelope);
  return await postCommand(body, {
    signature: await commandSignature(body),
    coreEnv,
  });
};

/** The admin snapshot as the admin reads it: signed, now, by `commandStaff`. All it shows of what commands changed. */
export const adminSnapshot = async (): Promise<AdminSnapshot> => {
  const body = JSON.stringify({
    sentAt: new Date().toISOString(),
    staff: { email: commandStaff },
  });
  const response = await routed(adminSnapshotPath, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [platformUpdateSignatureHeader]: await commandSignature(
        body,
        env.BETTER_AUTH_SECRET,
        adminSnapshotPurpose
      ),
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`The snapshot wasn't read (${response.status})`);
  }
  return adminSnapshotSchema.parse(await response.json());
};

/** A refusal: the code core answered with, for `outcome` to read. */
class CommandRefusedError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CommandRefusedError";
    this.code = code;
  }
}

const refusalSchema = z.object({ code: z.string() });

/** Delivers `command` once; throws with core's code when it refuses it. */
export const command = async (
  given: AdminCommand,
  coreEnv: Env = env
): Promise<AdminCommandAnswer> => {
  const response = await deliver(envelopeOf(given), coreEnv);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new CommandRefusedError(
      refusalSchema.safeParse(body).data?.code ?? String(response.status)
    );
  }
  return adminCommandAnswerSchema.parse(body);
};

/** The admin's commands, one call each, as staff used to make them in the company's Grasp. */
export const adminCommands = (coreEnv: Env = env) => ({
  setAgreements: async (agreements: Agreements) =>
    await command(
      { type: "onboarding.agreements", payload: { agreements } },
      coreEnv
    ),
  remind: async (people: string[]) =>
    await command({ type: "onboarding.remind", payload: { people } }, coreEnv),
  askIn: async (team: string) =>
    await command({ type: "onboarding.ask_in", payload: { team } }, coreEnv),
  sendMailAgain: async (person: string) =>
    await command(
      { type: "onboarding.send_mail_again", payload: { person } },
      coreEnv
    ),
  newStart: async (person: string) =>
    await command(
      { type: "onboarding.new_start", payload: { person } },
      coreEnv
    ),
  open: async () =>
    await command({ type: "onboarding.gate.open", payload: {} }, coreEnv),
  close: async () =>
    await command({ type: "onboarding.gate.close", payload: {} }, coreEnv),
  setThreshold: async (threshold: GateThreshold) =>
    await command(
      { type: "onboarding.gate.threshold", payload: { threshold } },
      coreEnv
    ),
  pause: async () =>
    await command({ type: "onboarding.pause", payload: {} }, coreEnv),
  resume: async () =>
    await command({ type: "onboarding.resume", payload: {} }, coreEnv),
  setRules: async (rules: OrgRules | null) =>
    await command({ type: "onboarding.rules", payload: { rules } }, coreEnv),
  countAsKnown: async (work: string, counted: boolean) =>
    await command(
      { type: "onboarding.count_as_known", payload: { work, counted } },
      coreEnv
    ),
  drawWorkAgain: async (work: string) =>
    await command(
      { type: "onboarding.draw_again", payload: { work } },
      coreEnv
    ),
  saveStephen: async (setup: StephenSetup | null) =>
    await command({ type: "onboarding.stephen", payload: { setup } }, coreEnv),
});
