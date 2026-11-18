import { isAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, Link, useRouteContext } from "@tanstack/react-router";

import { BackButton } from "../brain/back-button.tsx";
import { useBrainData } from "../brain/brain-data.ts";
import { blockStyles, Panel, tone } from "../brain/brain-home.tsx";
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
import { AppLogo } from "../connections/app-logo.tsx";
import { NotFoundState } from "../frame/page-states.tsx";
import { SectionTitle } from "../frame/page.tsx";
import { Badge } from "../grasp/badge/index.ts";
import { iconVars } from "../grasp/icons/icon.stylex.ts";
import { Brain as BrainMark, Icon } from "../grasp/icons/index.ts";
import { Link as TextLink } from "../grasp/link/index.ts";
import { PageHeader } from "../grasp/page-header/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// One part of the brain on its own page, as the prototype has it
// (`routes/brain/sections.$sectionId.tsx`). On the Vision page, admins
// also change the board's goals (goals-editor.tsx).

const styles = stylex.create({
  scroll: { flex: 1, minHeight: 0, overflowY: "auto" },
  group: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  // The part's mark on a white tile in the middle of a note's picture, in the part's colour.
  tile: {
    [iconVars.size]: grasp.iconMd,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: `calc(${grasp.space12} + ${grasp.space2})`,
    height: `calc(${grasp.space12} + ${grasp.space2})`,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftLow,
  },
  words: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    minWidth: 0,
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
}: {
  note: Note;
  section: BrainSection;
}) => (
  <Link
    params={{ noteId: note.id }}
    to="/brain/$noteId"
    {...stylex.props(blockStyles.block)}
  >
    <Panel group={section.group} short>
      {note.kind === "tool" || note.kind === "app" ? (
        <AppLogo name={note.title} size="lg" />
      ) : (
        <span {...stylex.props(styles.tile, tone[section.group].ink)}>
          <Icon icon={section.icon} />
        </span>
      )}
    </Panel>
    <span {...stylex.props(styles.words)}>
      <span {...stylex.props(blockStyles.name)}>
        <Text element="span" size="sm" weight="medium" wrap="truncate">
          {note.title}
        </Text>
      </span>
      <span {...stylex.props(styles.summary)}>
        <Text element="span" size="sm" tone="muted">
          {note.summary}
        </Text>
      </span>
    </span>
  </Link>
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
    return (
      <NotFoundState icon={BrainMark} title={t`Part of the brain not found`} />
    );
  }

  return (
    <div {...stylex.props(styles.scroll)}>
      <div {...stylex.props(blockStyles.column)}>
        <PageHeader
          aside={<Badge icon={section.icon}>{shownCount(folder)}</Badge>}
          breadcrumb={<BackButton />}
          description={i18n._(section.description)}
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
                  <TextLink
                    render={
                      <Link
                        params={{ noteId: group.page.id }}
                        to="/brain/$noteId"
                      />
                    }
                    variant="standalone"
                  >
                    {group.name}
                  </TextLink>
                ) : (
                  group.name
                )}
              </SectionTitle>
            )}
            <div {...stylex.props(blockStyles.blocks)}>
              {group.notes.map((note) => (
                <NoteBlock key={note.id} note={note} section={section} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};

export const Route = createFileRoute("/_shell/brain/sections/$sectionId")({
  component: SectionPage,
});
