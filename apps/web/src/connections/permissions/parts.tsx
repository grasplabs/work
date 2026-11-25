import { composioConsentText } from "@grasp-os/shared/connect";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { Text } from "@grasp-os/ui/components/text";
import {
  EyeIcon,
  Icon,
  LockIcon,
  PencilIcon,
  TrashIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { colors, radius, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import type { AllowedTool } from "../tool-choices.ts";
import { tally } from "./model.ts";
import type { ToolKind } from "./model.ts";

// The parts every permission concept shares: what each kind of tool means
// in a line, the trust line with the consent as written behind it, and the
// count the footer says.

/** A kind of tool in words: its name, what happens when Grasp uses one, and its mark. */
export interface KindWords {
  title: string;
  note: string;
  icon: IconData;
}

export const useKindWords = (): Readonly<Record<ToolKind, KindWords>> => {
  const { t } = useLingui();
  return {
    look: {
      title: t`View`,
      note: t`Runs without asking. Changes nothing.`,
      icon: EyeIcon,
    },
    change: {
      title: t`Create and change`,
      note: t`Asks the person first. A workflow does it as a step.`,
      icon: PencilIcon,
    },
    remove: {
      title: t`Delete and cancel`,
      note: t`Asks first. Often can't be undone.`,
      icon: TrashIcon,
    },
  };
};

const styles = stylex.create({
  mark: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    width: size.controlSm,
    height: size.controlSm,
    borderRadius: radius.md,
    [iconVars.size]: size.iconSm,
  },
  look: { backgroundColor: colors.successSubtle, color: colors.success },
  change: { backgroundColor: colors.warningSubtle, color: colors.warning },
  remove: {
    backgroundColor: colors.destructiveSubtle,
    color: colors.destructive,
  },
  trust: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: space[3],
    alignItems: "start",
    padding: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.muted,
  },
  trustIcon: {
    display: "flex",
    paddingTop: space[1],
    color: colors.mutedForeground,
    [iconVars.size]: size.iconSm,
  },
  trustWords: { display: "grid", gap: space[1] },
  dot: {
    display: "inline-block",
    flexShrink: 0,
    width: "0.5rem",
    height: "0.5rem",
    borderRadius: radius.full,
  },
  dotlook: { backgroundColor: colors.success },
  dotchange: { backgroundColor: colors.warning },
  dotremove: { backgroundColor: colors.destructive },
});

/** A kind's mark: its icon on its colour, green to red as the risk rises. */
export const KindMark = ({ kind }: { kind: ToolKind }) => {
  const words = useKindWords();
  return (
    <span aria-hidden {...stylex.props(styles.mark, styles[kind])}>
      <Icon icon={words[kind].icon} />
    </span>
  );
};

/** A kind's dot, for a dense row. */
export const KindDot = ({ kind }: { kind: ToolKind }) => (
  <span
    aria-hidden
    {...stylex.props(
      styles.dot,
      kind === "look" && styles.dotlook,
      kind === "change" && styles.dotchange,
      kind === "remove" && styles.dotremove
    )}
  />
);

/**
 * The trust line, in the page's language: where the access is kept and
 * what Grasp does with it. The consent itself stays word for word, behind
 * it: core keeps a hash of that exact text.
 */
export const TrustLine = ({ app }: { app: string }) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.trust)}>
      <span aria-hidden {...stylex.props(styles.trustIcon)}>
        <Icon icon={LockIcon} />
      </span>
      <div {...stylex.props(styles.trustWords)}>
        <Text color="secondary" size="sm">
          {t`Composio keeps the access to ${app} in its own cloud. Grasp never sees it and only uses what you turn on here. You can change this or disconnect at any time.`}
        </Text>
        <Collapsible fitContent variant="plain">
          <CollapsibleTrigger size="sm" weight="normal">
            {t`Read the full consent`}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Text color="muted" size="xs">
              {composioConsentText}
            </Text>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
};

/** What the choice adds up to, in a line for the footer. */
export const useTallyWords = (allowed: readonly AllowedTool[]): string => {
  const { t } = useLingui();
  const { read, asks } = tally(allowed);
  if (read + asks === 0) {
    return t`Nothing turned on yet`;
  }
  if (asks === 0) {
    return t`${read} actions, all view only`;
  }
  return t`${read} view, ${asks} ask first`;
};
