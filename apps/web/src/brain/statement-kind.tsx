import type { StatementKind } from "@grasp-os/shared/brain";
import {
  ArrowLeftRightIcon,
  CircleAlertIcon,
  ClockIcon,
  Icon,
  LightbulbIcon,
  RocketIcon,
  ScaleIcon,
  WrenchIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";

import { statementKindLabel } from "./brain.ts";

/**
 * One icon per kind of statement, as in the prototype
 * (`components/statement-kind.tsx`). Statements keep their one colour from
 * the graph, so the kind is told apart by its icon, not by a second palette.
 */
const kindIcon: Record<StatementKind, IconData> = {
  blocker: CircleAlertIcon,
  timeSink: ClockIcon,
  handover: ArrowLeftRightIcon,
  tool: WrenchIcon,
  rule: ScaleIcon,
  wish: LightbulbIcon,
  goal: RocketIcon,
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
