/**
 * Marks drawn with Damsko's tokens: words with a mark before them, what
 * needs someone (`Attention`, the warning's dot) and what is in place
 * (`Done`, a check in the success colour); and how much Grasp knows, in
 * dots (`KnowledgeDots`). The Damsko counterparts of parts.tsx's, which
 * the pages still on the kit keep until their area moves.
 */
import type { OrgKnowledge } from "@grasp-os/shared/admin/onboarding-admin";
import { CheckIcon, Icon } from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Fragment } from "react";
import type { ReactNode } from "react";

const styles = stylex.create({
  attention: { display: "flex", alignItems: "baseline", gap: space["2"] },
  dot: {
    width: "0.375rem",
    height: "0.375rem",
    flexShrink: 0,
    borderRadius: "50%",
    backgroundColor: colors.warning,
    transform: "translateY(-1px)",
  },
  words: { minWidth: 0 },
  done: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    color: colors.mutedForeground,
  },
  check: { display: "inline-flex", flexShrink: 0, color: colors.success },
  dots: { display: "flex", alignItems: "center", gap: space["1"] },
  knowledgeDot: {
    width: "0.375rem",
    height: "0.375rem",
    flexShrink: 0,
    borderRadius: "50%",
    backgroundColor: colors.border,
  },
  filled: { backgroundColor: colors.foreground },
  // Where Grasp opens: a thin upright line between the dots.
  gate: {
    display: "block",
    width: "1px",
    height: "0.875rem",
    flexShrink: 0,
    marginInline: "0.125rem",
    backgroundColor: colors.foreground,
  },
});

/** What needs someone, in words: the warning's dot, then the words in the text's colour. */
export const Attention = ({ children }: { children: ReactNode }) => (
  <span {...stylex.props(styles.attention)}>
    <span aria-hidden {...stylex.props(styles.dot)} />
    <span {...stylex.props(styles.words)}>{children}</span>
  </span>
);

/** Something that is in place: a check and a word, in the success colour. */
export const Done = ({ children }: { children: ReactNode }) => (
  <span {...stylex.props(styles.done)}>
    <span aria-hidden {...stylex.props(styles.check)}>
      <Icon icon={CheckIcon} />
    </span>
    {children}
  </span>
);

/** Where the rounding of a share of the dots may land just under a whole one. */
const dotSlack = 1e-9;

/**
 * How much Grasp knows about an organization, in dots: dark for what is
 * in, filling from the start, with a mark at the share where Grasp opens.
 * Dark up to the mark is ready. `label` says it to a screen reader.
 */
export const KnowledgeDots = ({
  knowledge,
  count,
  label,
}: {
  knowledge: Pick<OrgKnowledge, "percent" | "threshold">;
  count: number;
  label: string;
}) => {
  const filled = Math.floor((knowledge.percent / 100) * count + dotSlack);
  const gate = Math.round((knowledge.threshold / 100) * count);
  const mark = <span aria-hidden {...stylex.props(styles.gate)} />;
  return (
    <span {...stylex.props(styles.dots)}>
      <span {...stylex.props(visuallyHidden)}>{label}</span>
      {Array.from({ length: count }, (_, at) => (
        <Fragment key={at}>
          {at === gate ? mark : null}
          <span
            aria-hidden
            {...stylex.props(styles.knowledgeDot, at < filled && styles.filled)}
          />
        </Fragment>
      ))}
      {/* Where Grasp opens only once every dot is filled, the mark stands after the last. */}
      {gate >= count ? mark : null}
    </span>
  );
};
