import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { CardContent } from "@grasp-os/ui/components/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { ArrowRightIcon, Icon } from "@grasp-os/ui/lib/icons";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, Link } from "@tanstack/react-router";

import { OrgBrief } from "../../../admin/org-brief.tsx";
import { useOrganization } from "../../../admin/organization.tsx";
import { Panel, PanelNote } from "../../../admin/panel.tsx";
import { needWhere, sectionTo, sectionWords } from "../../../admin/sections.ts";
import { needLine } from "../../../admin/words.ts";

const styles = stylex.create({
  // What needs Grasp, and beside it from a wide window the brief.
  page: {
    display: "grid",
    gap: space["6"],
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.xl]: "minmax(0, 2fr) minmax(0, 1fr)",
    },
    alignItems: "start",
  },
});

/**
 * Everything that needs Grasp here, as the model works it out, each with
 * the section it is settled in: the overview of every organization shows
 * only the first few of all of them.
 */
const NeedsHere = () => {
  const { admin, view } = useOrganization();
  if (view.needs.length === 0) {
    return (
      <Panel title="Needs Grasp">
        <PanelNote>Nothing needs Grasp here right now.</PanelNote>
      </Panel>
    );
  }
  return (
    <Panel title="Needs Grasp">
      <CardContent flush>
        <ItemGroup separated>
          {view.needs.map((need, index) => {
            const text = needLine(need, view);
            const { section, search } = needWhere(need);
            return (
              <Item
                // The same need can stand twice, for two teams.
                key={`${need.kind}-${index}`}
                size="sm"
              >
                <ItemMedia>
                  <Badge dot variant="warning" />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{text}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button asChild size="sm" variant="outline">
                    <Link
                      aria-label={`Open ${sectionWords[section].title}: ${text}`}
                      params={{ clientId: admin.client.id }}
                      search={search}
                      to={sectionTo[section]}
                    >
                      {sectionWords[section].title}
                      <Icon icon={ArrowRightIcon} />
                    </Link>
                  </Button>
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      </CardContent>
    </Panel>
  );
};

const Overview = () => {
  const { admin, view } = useOrganization();
  return (
    <div {...stylex.props(styles.page)}>
      <NeedsHere />
      <OrgBrief clientId={admin.client.id} view={view} />
    </div>
  );
};

/**
 * An organization's overview: what needs Grasp there, and beside it the
 * brief for the next call. How it stands is in its column, on every section.
 */
export const Route = createFileRoute("/organizations/$clientId/")({
  component: Overview,
});
