// Concepts for the Brain's front, for Ruben to choose between. Never merged.
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";

import { Badge } from "../grasp/badge/index.ts";
import { Question } from "../grasp/icons/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { PageHeader } from "../grasp/page-header/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import type { Atlas, OpenItem } from "./brain-atlas.ts";

const styles = stylex.create({
  pane: { flexGrow: 1, minHeight: 0, overflowY: "auto" },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space6,
    boxSizing: "border-box",
    width: "100%",
    maxWidth: grasp.pageMeasure,
    marginInline: "auto",
    paddingInline: { default: grasp.space4, [media.fromTablet]: grasp.space12 },
    paddingBottom: grasp.space24,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.fromTablet]: "repeat(2, minmax(0, 1fr))",
    },
    gap: grasp.space4,
  },
  side: {
    display: { default: "none", [media.fromRail]: "flex" },
    flexDirection: "column",
    gap: grasp.space4,
    flexShrink: 0,
    boxSizing: "border-box",
    width: grasp.inspectorWidth,
    overflowY: "auto",
    padding: grasp.space4,
    paddingBottom: grasp.space24,
  },
  row: { display: "flex", flexGrow: 1, minHeight: 0, minWidth: 0 },
  atlas: { display: "flex", flexGrow: 1, minWidth: 0, minHeight: 0 },
  facts: { display: "flex", flexDirection: "column", gap: grasp.space2 },
});

const allOpen = (atlas: Atlas): OpenItem[] => {
  const seen = new Set<string>();
  return atlas.regions
    .flatMap((region) => region.open)
    .filter((item) => {
      if (seen.has(item.id)) {
        return false;
      }
      seen.add(item.id);
      return true;
    });
};

const OpenList = ({ items }: { items: OpenItem[] }) => (
  <ItemGroup separated>
    {items.map((item) => (
      <Item
        key={item.id}
        render={<Link params={{ noteId: item.noteId }} to="/brain/$noteId" />}
        size="xs"
      >
        <ItemMedia icon={Question} iconLook="inline" />
        <ItemContent>
          <ItemTitle>{item.question}</ItemTitle>
          {item.who === undefined ? null : (
            <ItemDescription>{item.who}</ItemDescription>
          )}
        </ItemContent>
      </Item>
    ))}
  </ItemGroup>
);

/** B: the drawing as now, with what is still open beside it. */
export const FrontWithOpen = ({
  atlas,
  children,
}: {
  atlas: Atlas;
  children: React.ReactNode;
}) => {
  const { t } = useLingui();
  const open = allOpen(atlas);
  return (
    <div {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.atlas)}>{children}</div>
      <aside {...stylex.props(styles.side)}>
        <SectionCard
          aside={<Badge tone="attention">{open.length}</Badge>}
          density="compact"
          title={t`Still open`}
        >
          <OpenList items={open} />
        </SectionCard>
      </aside>
    </div>
  );
};

/** C: no drawing on the front: what is still open, then each part of the brain as a card. */
export const FrontAsParts = ({ atlas }: { atlas: Atlas }) => {
  const { t } = useLingui();
  const open = allOpen(atlas);
  return (
    <div {...stylex.props(styles.pane)}>
      <div {...stylex.props(styles.column)}>
        <PageHeader title={t`Brain`} />
        <SectionCard
          aside={<Badge tone="attention">{open.length}</Badge>}
          density="compact"
          title={t`Still open`}
        >
          <OpenList items={open} />
        </SectionCard>
        <div {...stylex.props(styles.grid)}>
          {atlas.regions
            .filter(
              (region) => region.notes.length > 0 || region.open.length > 0
            )
            .map((region) => {
              const count = region.notes.length;
              return (
                <SectionCard
                  aside={
                    region.open.length > 0 ? (
                      <Badge tone="attention">{region.open.length}</Badge>
                    ) : undefined
                  }
                  density="compact"
                  description={region.does}
                  key={region.id}
                  title={region.name}
                >
                  <div {...stylex.props(styles.facts)}>
                    {region.facts.map((fact) => (
                      <Text key={fact} size="sm">
                        {fact}
                      </Text>
                    ))}
                    {region.waitingLabel === undefined ? null : (
                      <Text size="sm" tone="muted">
                        {region.waitingLabel}
                      </Text>
                    )}
                    <Link search={{ region: region.id }} to="/brain">
                      {t`${plural(count, { one: "Open its # note", other: "Open its # notes" })}`}
                    </Link>
                  </div>
                </SectionCard>
              );
            })}
        </div>
      </div>
    </div>
  );
};
