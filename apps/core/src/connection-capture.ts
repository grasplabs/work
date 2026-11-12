import { delegateActorOf } from "@grasp-os/shared/audit";
import type { ConnectResult } from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import { redact } from "@grasp-os/shared/redact";
import { drizzle } from "drizzle-orm/d1";

import { chatAuthority } from "./agent-scope.ts";
import type { AgentScope } from "./agent-scope.ts";
import { keepAuditEvent } from "./audit-outbox.ts";
import { addSource } from "./brain-next.ts";
import { captureIdOf } from "./connection-capture-key.ts";
import type { CapturedItem } from "./connection-capture-key.ts";

// Capture (GRA-1730): what a chat's agent reads through a connection is
// kept as a source in the Brain, so every connected system feeds it with
// nothing built per connector. Core relays every call (agent-connections.ts)
// and captures there; connect and the Brain never call each other. The
// threat model is on GRA-1730; in short:
//
// - Connect decides what may be kept (`ConnectResult.keep`): a read it
//   carried out just now, from a connection whose provider's terms allow
//   copies. Without its word nothing is kept: a change, a held call, a
//   replay, a refusal.
// - The readers are the chat's person alone (`owner`): a chat is one
//   person's, and they could read all it read. Never a team or the
//   company, whatever the connection is.
// - Only the output is kept, with credentials redacted (`redact`, the net
//   the chat and the model already use); never the call's input, which
//   may hold what the agent typed. Outside text is content: a captured
//   source is never an instruction file.
// - Capturing never fails the call: the agent has its answer either way.
//   Every capture ends in one audit event, of IDs and counts alone: kept
//   (with the version), skipped (why), or failed, which is also what one
//   reads whose add may have landed after all.

/**
 * The most of an answer kept, in bytes of UTF-8: a larger one is skipped,
 * never cut, so a source never holds part of an answer as if whole.
 */
export const captureBytesMax = 256 * 1024;

const encoder = new TextEncoder();

/** The audit event a capture ends in, through core's outbox. */
const audited = async (
  env: Env,
  scope: AgentScope,
  connectionId: string,
  action:
    | "brain.capture.kept"
    | "brain.capture.skipped"
    | "brain.capture.failed",
  detail: Record<string, string | number>
): Promise<void> => {
  await keepAuditEvent(env, drizzle(env.DB), {
    actor: delegateActorOf(chatAuthority(scope), scope.via),
    action,
    target: { type: "connection", id: connectionId },
    detail: { ...detail, chat: scope.chatId },
  });
};

/**
 * Keeps what the chat's agent read through `connectionId` (`result`) as a
 * source its person alone may read, if connect said it may be kept. The
 * same items read again make their next version; an answer that names no
 * item is its own source. Never throws.
 */
export const captureRead = async (
  env: Env,
  scope: AgentScope,
  connectionId: string,
  result: ConnectResult
): Promise<void> => {
  const { keep } = result;
  if (keep === undefined) {
    return;
  }
  const text = redact(result.output);
  const bytes = encoder.encode(text).length;
  if (bytes > captureBytesMax) {
    await audited(env, scope, connectionId, "brain.capture.skipped", {
      reason: "too_large",
      bytes,
    });
    return;
  }
  const item: CapturedItem =
    keep === "item" && result.provenance.length > 0
      ? { kind: "item", items: result.provenance }
      : { kind: "answer", text };
  try {
    const id = await captureIdOf(connectionId, scope.personId, item);
    const { version } = await addSource(env, {
      source: { producer: "capture", id },
      // A change of its own each time: the same text again is the current
      // version (the Brain's rule), so a repeat after a lost reply adds
      // nothing, and an item that changed back is a version again.
      change: crypto.randomUUID(),
      text,
      readers: { kind: "owner", personId: scope.personId },
    });
    await audited(env, scope, connectionId, "brain.capture.kept", {
      version,
      bytes,
    });
  } catch (error) {
    log.warn("brain.capture.failed", {
      connectionId,
      chatId: scope.chatId,
      ...errorFields(error),
    });
    await audited(env, scope, connectionId, "brain.capture.failed", {
      bytes,
    });
  }
};
