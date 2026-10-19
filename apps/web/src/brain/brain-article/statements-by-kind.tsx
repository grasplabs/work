import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";

import type { Kern, StatementRow } from "../article-kern.ts";
import { KindLabel } from "../statement-kind.tsx";
import { PartHeading, StatementLine } from "./kern.tsx";

/**
 * The statements one kind at a time, a tab per kind, so the page stays as short as the longest
 * kind. From the prototype's `components/brain-article/statements-by-kind.tsx`. A link to one
 * statement (`activeId`) opens its kind's tab and brings it into view.
 */
export const StatementsByKind = ({
  kern,
  rows,
  activeId,
}: {
  kern: Kern;
  rows: StatementRow[];
  activeId?: string | undefined;
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
    <section className="flex flex-col gap-3" ref={box}>
      <PartHeading count={rows.length} title={t`What they told us`} />
      <Tabs onValueChange={setTab} value={tab}>
        <TabsList className="max-w-full justify-start overflow-x-auto overflow-y-hidden">
          {kern.counts.map(({ kind, count }) => (
            <TabsTrigger key={kind} value={kind}>
              <KindLabel kind={kind} />
              <span className="text-muted-foreground font-normal tabular-nums">
                {count}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
        {kern.counts.map(({ kind }) => (
          <TabsContent key={kind} value={kind}>
            <ul className="flex flex-col">
              {rows
                .filter((row) => row.statement.kind === kind)
                .map((row) => (
                  <StatementLine key={row.statement.id} row={row} />
                ))}
            </ul>
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
};
