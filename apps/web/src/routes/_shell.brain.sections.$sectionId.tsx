import { isAdmin } from "@grasp-os/shared/roles";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  CardDescription,
  CardLink,
  CardMedia,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Container } from "@grasp-os/ui/components/container";
import { Link as TextLink } from "@grasp-os/ui/components/link";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { Icon } from "@grasp-os/ui/lib/icons";
import {
  colors,
  radius,
  shadow,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, Link, useRouteContext } from "@tanstack/react-router";

import { BackButton } from "../brain/back-button.tsx";
import { useBrainData } from "../brain/brain-data.ts";
import { blockStyles, Panel, tone } from "../brain/brain-home.tsx";
import { BrainNotFound } from "../brain/brain-not-found.tsx";
import {
  brainSections,
  findFolder,
  noteGroups,
  shownCount,
} from "../brain/brain-sections.ts";
import type { BrainSection } from "../brain/brain-sections.ts";
import { folderTree, groupLabel } from "../brain/brain.ts";
import type { Note } from "../brain/brain.ts";
import { GoalsEditor } from "../brain/goals-editor.tsx";
import { SectionTitle } from "../brain/section-title.tsx";
import { AppLogo } from "../connections/app-logo.tsx";

// One part of the brain on its own page, as the prototype has it
// (`routes/brain/sections.$sectionId.tsx`). On the Vision page, admins
// also change the board's goals (goals-editor.tsx).

const styles = stylex.create({
  scroll: { flex: 1, minHeight: 0, overflowY: "auto" },
  group: { display: "flex", flexDirection: "column", gap: space["3"] },
  // The part's mark on a white tile in the middle of a note's picture, in the part's colour.
  tile: {
    [iconVars.size]: size.iconDefault,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: `calc(${space["12"]} + ${space["2"]})`,
    height: `calc(${space["12"]} + ${space["2"]})`,
    borderRadius: radius.base,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: shadow.sm,
  },
  // A note's sentence, two lines at most.
  summary: {
    display: "-webkit-box",
    overflow: "hidden",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
  },
});

/**
 * A note as a block, in the home's style: its part's pale grid with the note's logo or the part's
 * icon on a tile in the middle, then its name and its one sentence.
 */
const NoteBlock = ({
  note,
  section,
  headingLevel,
}: {
  note: Note;
  section: BrainSection;
  /** Its title's level: under the page's title, or under a group's heading. */
  headingLevel: 2 | 3;
}) => (
  <CardLink asChild>
    <Link params={{ noteId: note.id }} to="/brain/$noteId">
      <CardMedia>
        <Panel group={section.group} short>
          {note.kind === "tool" || note.kind === "app" ? (
            <AppLogo name={note.title} size="lg" />
          ) : (
            <span {...stylex.props(styles.tile, tone[section.group].ink)}>
              <Icon icon={section.icon} />
            </span>
          )}
        </Panel>
      </CardMedia>
      <div {...stylex.props(blockStyles.nameRow)}>
        <CardTitle level={headingLevel}>{note.title}</CardTitle>
      </div>
      <CardDescription>
        <span {...stylex.props(styles.summary)}>{note.summary}</span>
      </CardDescription>
    </Link>
  </CardLink>
);

/**
 * One part of the brain on its own page, such as Teams: what it holds, then a block for each of
 * its notes to open, under a heading for each group when it has groups.
 */
const SectionPage = () => {
  const { t, i18n } = useLingui();
  const { sectionId } = Route.useParams();
  const { brain, workspace } = useBrainData();
  const { identity } = useRouteContext({ from: "/_shell" });
  const section = brainSections.find(
    (candidate) => candidate.slug === sectionId
  );
  const folder = section
    ? findFolder(folderTree(brain.notes), section.key)
    : undefined;

  if (!section || !folder) {
    return <BrainNotFound title={t`Part of the brain not found`} />;
  }

  return (
    <div {...stylex.props(styles.scroll)}>
      <Container size="lg">
        <PageHeader
          badge={<Badge icon={section.icon}>{shownCount(folder)}</Badge>}
          breadcrumb={<BackButton />}
          title={i18n._(groupLabel[section.group])}
        />
        {section.group === "vision" && isAdmin(identity.role) ? (
          <GoalsEditor goals={workspace.goals} />
        ) : null}
        {noteGroups(folder).map((group) => (
          <section key={group.key} {...stylex.props(styles.group)}>
            {group.name === undefined ? null : (
              <SectionTitle count={String(group.notes.length)}>
                {group.page ? (
                  <TextLink asChild variant="plain">
                    <Link
                      params={{ noteId: group.page.id }}
                      to="/brain/$noteId"
                    >
                      {group.name}
                    </Link>
                  </TextLink>
                ) : (
                  group.name
                )}
              </SectionTitle>
            )}
            <div {...stylex.props(blockStyles.blocks)}>
              {group.notes.map((note) => (
                <NoteBlock
                  headingLevel={group.name === undefined ? 2 : 3}
                  key={note.id}
                  note={note}
                  section={section}
                />
              ))}
            </div>
          </section>
        ))}
      </Container>
    </div>
  );
};

export const Route = createFileRoute("/_shell/brain/sections/$sectionId")({
  component: SectionPage,
});
