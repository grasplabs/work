import {
  adminKickoffPath,
  adminKickoffPurpose,
} from "@grasp-os/shared/admin-kickoff";
import type { AdminKickoffAsk } from "@grasp-os/shared/admin-kickoff";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toBase64, toHex } from "@grasp-os/shared/encoding";
import type {
  KickoffInput,
  KickoffView,
  VisionField,
} from "@grasp-os/shared/kickoff";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import { commandStaff } from "./admin-command.ts";
import { routed } from "./sign-in.ts";

// The kickoff as Grasp's staff bring it in from the admin
// (src/admin-kickoff.ts): signed with this company's key for the kickoff,
// posted through the router, as the staff member Access let in. The admin
// sees only what it brought; the tests read the kickoff as core keeps it,
// from the store, to look at what the reading kept.

/** A refusal: the code core answered with, for `outcome` to read. */
class KickoffRefusedError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "KickoffRefusedError";
    this.code = code;
  }
}

const refusalSchema = z.object({ code: z.string() });

/** Asks `ask` of the kickoff as the admin does; throws with core's code when it refuses. */
const askKickoff = async (ask: AdminKickoffAsk): Promise<void> => {
  const body = JSON.stringify({
    sentAt: new Date().toISOString(),
    staff: { email: commandStaff },
    ask,
  });
  const key = await hkdfHmacKey(env.BETTER_AUTH_SECRET, adminKickoffPurpose, [
    "sign",
  ]);
  const signature = toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
  const response = await routed(adminKickoffPath, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [platformUpdateSignatureHeader]: signature,
    },
    body,
  });
  const answer: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new KickoffRefusedError(
      refusalSchema.safeParse(answer).data?.code ?? String(response.status)
    );
  }
};

/** The kickoff as core keeps it. */
const keptKickoff = async (): Promise<KickoffView> =>
  await onboardingStore(env).kickoff();

/** The kickoff from Grasp's admin, one call each, answering with the kickoff as core keeps it. */
export const adminKickoff = () => ({
  /** Brings `input`'s transcript in, and reads it. */
  saveKickoff: async ({
    locale,
    transcript,
  }: KickoffInput): Promise<KickoffView> => {
    await askKickoff({
      kind: "save",
      locale,
      transcript:
        "text" in transcript
          ? { text: transcript.text }
          : {
              file: {
                name: transcript.file.name,
                base64: toBase64(transcript.file.bytes),
              },
            },
    });
    return await keptKickoff();
  },
  /** Keeps the sponsor's answer to `field`; empty takes it back. */
  answerKickoff: async (
    field: VisionField,
    text: string
  ): Promise<KickoffView> => {
    await askKickoff({ kind: "answer", field, text });
    return await keptKickoff();
  },
});
