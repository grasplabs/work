import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Clock, Icon } from "../grasp/icons/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// The one shape every workflow approval takes in direction C (Track): what
// is asked, where it comes from, what to read before answering, until when
// it waits, and the answers, the yes last. A decision a run waits for
// (decision-card.tsx), a start a chat's agent asked for and a trigger's ask
// to start its workflow (inbox/item-detail.tsx) all stand in it.

const styles = stylex.create({
  card: { width: "100%" },
  stack: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  source: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space3,
  },
  deadline: { display: "flex", alignItems: "center", gap: grasp.space2 },
  answers: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
  },
  push: { flexGrow: 1 },
});

/**
 * Where it comes from, in one quiet line: `said`, then the way to it
 * (`open`), where the reader may go there.
 */
export const ApprovalSource = ({
  said,
  open,
}: {
  said: string | undefined;
  open?: ReactNode;
}) => (
  <span {...stylex.props(styles.source)}>
    {said === undefined ? null : (
      <Text element="span" size="sm" tone="muted">
        {said}
      </Text>
    )}
    {open}
  </span>
);

/** Its answers in a row: `extra` first, the answers at the end, the yes last. */
export const ApprovalAnswers = ({
  extra,
  children,
}: {
  extra?: ReactNode;
  children?: ReactNode;
}) => (
  <div {...stylex.props(styles.answers)}>
    {extra}
    <span {...stylex.props(styles.push)} />
    {children}
  </div>
);

export const ApprovalCard = ({
  title,
  source,
  details,
  deadline,
  children,
}: {
  title: string;
  /** Where it comes from (`ApprovalSource`). */
  source: ReactNode;
  /** What to read before answering. */
  details?: ReactNode;
  /** Until when it waits, in words; none once it no longer does. */
  deadline?: string | undefined;
  /** The answers, or how it ended. */
  children: ReactNode;
}) => (
  <SectionCard layout={styles.card} title={title}>
    <div {...stylex.props(styles.stack)}>
      {source}
      {details}
      {deadline === undefined ? null : (
        <span {...stylex.props(styles.deadline)}>
          <Icon icon={Clock} />
          <Text element="span" size="sm" tone="muted">
            {deadline}
          </Text>
        </span>
      )}
      {children}
    </div>
  </SectionCard>
);
