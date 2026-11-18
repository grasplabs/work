import type { MemoryKind } from "@grasp-os/shared/knowledge";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Fragment } from "react";
import type { ReactElement, ReactNode, RefObject } from "react";

import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// What the Memory page's parts share: a record's kind in words, the
// record a command's receipt names, a form's idempotency key, a line of
// facts about a record, and the room a panel's card gives its words.

const styles = stylex.create({
  // A sentence in an inspector's card, inset as the card's rows are.
  cardWords: {
    margin: 0,
    paddingBlock: grasp.space3,
    paddingInline: grasp.inspectorInset,
  },
});

/** A fact about a record, under a lasting key. */
export interface Fact {
  id: string;
  fact: ReactElement | string;
}

/** Facts about a record on one line, a dot between them. */
export const FactLine = ({ facts }: { facts: readonly Fact[] }) =>
  facts.map(({ id, fact }, at) => (
    <Fragment key={id}>
      {at === 0 ? null : " · "}
      {fact}
    </Fragment>
  ));

/** A sentence in an inspector panel's card, where rows would stand. */
export const CardWords = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.cardWords)}>{children}</div>
);

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
