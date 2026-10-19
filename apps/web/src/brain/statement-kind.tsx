import type { StatementKind } from "@grasp-os/shared/brain";
import { useLingui } from "@lingui/react/macro";
import {
  ArrowRightLeftIcon,
  HourglassIcon,
  LightbulbIcon,
  OctagonAlertIcon,
  ScaleIcon,
  TargetIcon,
  WrenchIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { statementKindLabel } from "./brain.ts";

/**
 * One icon per kind of statement, as in the prototype
 * (`components/statement-kind.tsx`). Statements keep their one colour from
 * the graph, so the kind is told apart by its icon, not by a second palette.
 */
export const kindIcon: Record<StatementKind, LucideIcon> = {
  blocker: OctagonAlertIcon,
  timeSink: HourglassIcon,
  handover: ArrowRightLeftIcon,
  tool: WrenchIcon,
  rule: ScaleIcon,
  wish: LightbulbIcon,
  goal: TargetIcon,
};

/** The kind of a statement with its icon, to sit inside a label, chip or menu item. */
export const KindLabel = ({ kind }: { kind: StatementKind }) => {
  const { i18n } = useLingui();
  const Icon = kindIcon[kind];
  return (
    <>
      <Icon aria-hidden="true" className="size-3.5 flex-none" />
      {i18n._(statementKindLabel[kind])}
    </>
  );
};
