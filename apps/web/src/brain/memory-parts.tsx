import type { MemoryKind } from "@grasp-os/shared/knowledge";
import { useLingui } from "@lingui/react/macro";
import type { RefObject } from "react";

// What the Memory page's parts share: a record's kind in words, the
// record a command's receipt names, and a form's idempotency key.

/** What kind of thing a record holds, in words. */
export const KindLabel = ({ kind }: { kind: MemoryKind }) => {
  const { t } = useLingui();
  const labels: Record<MemoryKind, string> = {
    fact: t({ message: "A fact", context: "memory record kind" }),
    preference: t({ message: "A preference", context: "memory record kind" }),
    experience: t({ message: "An experience", context: "memory record kind" }),
    lesson: t({ message: "A lesson", context: "memory record kind" }),
  };
  return labels[kind];
};

/** The record a command's receipt names, if it names one. */
export const recordOf = (receipt: {
  resourceRefs: readonly { kind: string; memoryId?: string }[];
}): string | undefined =>
  receipt.resourceRefs.find((ref) => ref.kind === "memory")?.memoryId;

/**
 * The idempotency key `held` keeps for a form, made the first time it is
 * asked for: one key while the form is open, so trying again after a lost
 * answer answers the same receipt, never a second record.
 */
export const keyOf = (held: RefObject<string | null>): string => {
  held.current ??= crypto.randomUUID();
  return held.current;
};
