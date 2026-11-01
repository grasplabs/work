/**
 * Steering a client's onboarding from the admin
 * (`@grasp-os/shared/admin-command`, which lists what can go wrong):
 * every change staff make is a command in one signed envelope, delivered
 * to the company's core, which applies it once by its id and audits it
 * as the staff member Access let in. A command answers with no data:
 * the page reads the snapshot again to show what changed.
 *
 * Only one delivery is built: straight to the company's core, through
 * the router's route with the router secret, as the kickoff and the
 * snapshot are asked (src/clients/kickoff.ts). An on-prem core, which
 * only connects out, will fetch its pending commands instead; that is a
 * second delivery behind `deliverCommand`, with the same envelope.
 */
import {
  adminCommandAnswerSchema,
  adminCommandPath,
  adminCommandPurpose,
  adminCommandSchema,
} from "@grasp-os/shared/admin-command";
import type {
  AdminCommand,
  AdminCommandEnvelopeInput,
} from "@grasp-os/shared/admin-command";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import { toHex } from "@grasp-os/shared/encoding";
import { log } from "@grasp-os/shared/log";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { routerSecretHeader } from "@grasp-os/shared/router";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { clientCore } from "./client-core.ts";
import type { ClientCore } from "./client-core.ts";

/** How long the company's core may take to apply a command: drawing a piece of work again only queues it. */
export const commandTimeoutMs = 30_000;

/** What staff ask, for one organization. */
export const commandInputSchema = z.object({
  clientId: z.string().min(1).max(63),
  command: adminCommandSchema,
});

/**
 * Why a command wasn't applied, as the page words it:
 * - `not_deployed`: the company has no core to deliver it to yet;
 * - `shut_out`: the company keeps Grasp's staff out now;
 * - `refused`: its core turned the delivery away;
 * - `pending`: the same command is being applied right now;
 * - one of the onboarding's own codes, for a change it refused as it stands;
 * - `not_answered`: the delivery failed or took too long.
 */
export type CommandRefusal =
  | "not_deployed"
  | "shut_out"
  | "refused"
  | "pending"
  | "onboarding.no_link"
  | "onboarding.no_team"
  | "onboarding.no_work"
  | "onboarding.no_failed_mail"
  | "onboarding.nothing_to_draw"
  | "onboarding.invalid"
  | "not_answered";

/** What the page gets back: applied, or why not. */
export interface CommandAnswer {
  refused: CommandRefusal | null;
}

const onboardingCodes: ReadonlySet<string> = new Set([
  "onboarding.no_link",
  "onboarding.no_team",
  "onboarding.no_work",
  "onboarding.no_failed_mail",
  "onboarding.nothing_to_draw",
  "onboarding.invalid",
]);

const isOnboardingCode = (code: string): code is CommandRefusal =>
  onboardingCodes.has(code);

/** Why core refused, in the page's terms, from its status and code. */
const refusalOf = (status: number, code: string | null): CommandRefusal => {
  if (code === "onboarding.staff_only") {
    return "shut_out";
  }
  if (code === "admin.command_pending") {
    return "pending";
  }
  if (code !== null && isOnboardingCode(code)) {
    return code;
  }
  return status === 401 || status === 403 ? "refused" : "not_answered";
};

/** Core's error code in an answer that isn't OK, if it gave one. */
const codeOf = async (response: Response): Promise<string | null> => {
  try {
    const body: unknown = await response.json();
    return z.object({ code: z.string() }).safeParse(body).data?.code ?? null;
  } catch {
    return null;
  }
};

const encoder = new TextEncoder();

/** Posts `envelope` to `core`, signed for commands: what it answered. */
const postDirectly = async (
  core: ClientCore,
  envelope: AdminCommandEnvelopeInput,
  signal: AbortSignal
): Promise<CommandAnswer> => {
  const body = JSON.stringify(envelope);
  const key = await hkdfHmacKey(core.authSecret, adminCommandPurpose, ["sign"]);
  const signature = toHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)))
  );
  const response = await core.address.fetch(
    `${core.address.origin}${adminCommandPath}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [routerSecretHeader]: core.routerSecret,
        [platformUpdateSignatureHeader]: signature,
      },
      body,
      // Never followed: a redirect would send the signed command and the
      // router secret wherever it points. A 3xx isn't ok, so it reads as
      // not answered.
      redirect: "manual",
      signal,
    }
  );
  if (!response.ok) {
    return { refused: refusalOf(response.status, await codeOf(response)) };
  }
  const answer = adminCommandAnswerSchema.safeParse(
    await response.json().catch(() => null)
  );
  return { refused: answer.success ? null : "not_answered" };
};

/**
 * Delivers `envelope` to client `clientId`'s core: what it answered.
 * Never throws for an answer that didn't come.
 */
export const deliverCommand = async (
  env: Env,
  clientId: string,
  envelope: AdminCommandEnvelopeInput
): Promise<CommandAnswer> => {
  const core = await clientCore(env, clientId);
  if (core === null) {
    return { refused: "not_deployed" };
  }
  const limit = deadline(commandTimeoutMs);
  try {
    return await Promise.race([
      postDirectly(core, envelope, limit.signal),
      whenAborted(limit.signal),
    ]);
  } catch {
    log.warn("admin.command_unanswered", {
      clientId,
      type: envelope.type,
      error: limit.stopped() === "timeout" ? "timeout" : "no_answer",
    });
    return { refused: "not_answered" };
  } finally {
    limit.clear();
  }
};

/** `command` from `staff`, in its envelope: a new id, issued now. */
export const envelopeOf = (
  staff: Pick<Staff, "email">,
  command: AdminCommand
): AdminCommandEnvelopeInput => ({
  id: crypto.randomUUID(),
  ...command,
  staff: { email: staff.email },
  issuedAt: new Date().toISOString(),
});

/** What `staff` asked of client `clientId`'s onboarding, delivered: applied, or why not. */
export const giveCommand = async (
  env: Env,
  staff: Pick<Staff, "email">,
  input: z.input<typeof commandInputSchema>
): Promise<CommandAnswer> => {
  const { clientId, command } = commandInputSchema.parse(input);
  return await deliverCommand(env, clientId, envelopeOf(staff, command));
};
