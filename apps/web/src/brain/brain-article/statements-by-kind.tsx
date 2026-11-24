import type { Statement } from "@grasp-os/shared/brain";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";

import type { Kern, StatementRow } from "../article-kern.ts";
import { isTeamClaim } from "../brain.ts";
import { KindLabel } from "../statement-kind.tsx";
import { PartHeading, StatementLine } from "./kern.tsx";

const styles = stylex.create({
  part: {
    display: "flex",
    flexDirection: "column",
    gap: space["3"],
  },
  kind: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["2"],
  },
  count: {
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
});

/**
 * The statements one kind at a time, a tab per kind, so the page stays as short as the longest
 * kind. From the prototype's `components/brain-article/statements-by-kind.tsx`. A link to one
 * statement (`activeId`) opens its kind's tab and brings it into view.
 */
export const StatementsByKind = ({
  kern,
  rows,
  activeId,
  onRemove,
}: {
  kern: Kern;
  rows: StatementRow[];
  activeId?: string | undefined;
  /** Takes one statement out of the brain, for whoever may: never a team's claim. */
  onRemove?: ((statement: Statement) => void) | undefined;
}) => {
  const { t } = useLingui();
  const box = useRef<HTMLElement>(null);
  const kindOf = (id: string | undefined) =>
    rows.find((row) => row.statement.id === id)?.statement.kind;
  const [tab, setTab] = useState(kindOf(activeId) ?? kern.counts[0]?.kind);
  const [opened, setOpened] = useState(activeId);
  if (activeId !== opened) {
    setOpened(activeId);
    const kind = kindOf(activeId);
    if (kind !== undefined) {
      setTab(kind);
    }
  }
  useEffect(() => {
    if (activeId === undefined) {
      return;
    }
    box.current
      ?.querySelector(`[data-statement="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [activeId]);
  return (
    <section ref={box} {...stylex.props(styles.part)}>
      <PartHeading count={rows.length} title={t`What they told us`} />
      <Tabs
        onValueChange={(value) => {
          const chosen = kern.counts.find((each) => each.kind === value);
          if (chosen !== undefined) {
            setTab(chosen.kind);
          }
        }}
        value={tab}
      >
        <TabsList variant="line">
          {kern.counts.map(({ kind, count }) => (
            <TabsTrigger key={kind} value={kind}>
              <span {...stylex.props(styles.kind)}>
                <KindLabel kind={kind} />
                <span {...stylex.props(styles.count)}>{count}</span>
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
        {kern.counts.map(({ kind }) => (
          <TabsContent key={kind} value={kind}>
            <ul {...stylex.props(styles.list)}>
              {rows
                .filter((row) => row.statement.kind === kind)
                .map((row) => (
                  <StatementLine
                    key={row.statement.id}
                    // Never a team's claim: it stands while five of its
                    // people back it (GRA-1748).
                    onRemove={
                      isTeamClaim(row.statement.id) ? undefined : onRemove
                    }
                    row={row}
                  />
                ))}
            </ul>
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
};
