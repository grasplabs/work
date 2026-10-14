import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { useLingui } from "@lingui/react/macro";

import type { Kern, StatementRow } from "../article-kern.ts";
import { KindLabel } from "../statement-kind.tsx";
import { PartHeading, StatementLine } from "./kern.tsx";

/**
 * The statements one kind at a time, a tab per kind, so the page stays as short as the longest
 * kind. From the prototype's `components/brain-article/statements-by-kind.tsx`.
 */
export const StatementsByKind = ({
  kern,
  rows,
}: {
  kern: Kern;
  rows: StatementRow[];
}) => {
  const { t } = useLingui();
  return (
    <section className="flex flex-col gap-3">
      <PartHeading count={rows.length} title={t`What they told us`} />
      <Tabs defaultValue={kern.counts[0]?.kind}>
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
