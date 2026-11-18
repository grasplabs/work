import type { StatementKind } from "@grasp-os/shared/brain";
import { useLingui } from "@lingui/react/macro";

import {
  Clock,
  Failed,
  Icon,
  Rocket,
  Scale,
  Swap,
  Thought,
  Tool,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import { statementKindLabel } from "./brain.ts";

/**
 * One icon per kind of statement, as in the prototype
 * (`components/statement-kind.tsx`). Statements keep their one colour from
 * the graph, so the kind is told apart by its icon, not by a second palette.
 */
export const kindIcon: Record<StatementKind, IconData> = {
  blocker: Failed,
  timeSink: Clock,
  handover: Swap,
  tool: Tool,
  rule: Scale,
  wish: Thought,
  goal: Rocket,
};

/** The kind of a statement with its icon, to sit inside a label, chip or menu item. */
export const KindLabel = ({ kind }: { kind: StatementKind }) => {
  const { i18n } = useLingui();
  return (
    <>
      <Icon icon={kindIcon[kind]} />
      {i18n._(statementKindLabel[kind])}
    </>
  );
};
