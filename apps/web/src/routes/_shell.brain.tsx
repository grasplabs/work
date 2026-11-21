import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  createFileRoute,
  Outlet,
  useMatchRoute,
  useParams,
} from "@tanstack/react-router";

import { atlasOf, TEAM_FOLDER } from "../brain/brain-atlas.ts";
import type { Atlas } from "../brain/brain-atlas.ts";
import type { BrainData } from "../brain/brain-data.ts";
import { brainSections } from "../brain/brain-sections.ts";
import {
  buildBrain,
  folderName,
  folderTree,
  groupLabel,
} from "../brain/brain.ts";
import type { Folder, Note } from "../brain/brain.ts";
import { NoteActions } from "../brain/note-actions.tsx";
import { onArticle } from "../brain/note-page.tsx";
import { NoteReveal } from "../brain/note-reveal.tsx";
import { readBrain } from "../brain/read-brain.ts";
import { BrainPending } from "../frame/page-skeletons-b.tsx";
import { PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import type { Crumb } from "../frame/site-header.tsx";
import type { Loaded } from "../load-from-core.tsx";

const styles = stylex.create({
  // The navigation and the page beside it, filling the page's card.
  body: {
    display: "flex",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minHeight: 0,
  },
  // The brain, a part or a note, over which a note's dots are carried in.
  page: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
  },
});

// The Brain, as the prototype lays it out (`routes/brain.tsx`): its
// navigation on the left; on the right the brain itself, an atlas to
// explore, a part's page, or one note. The workspace is read once on the
// way in and built into the brain here, in the person's language:
// switching language reads it again (main.tsx), and so does anything that
// invalidates the router.

/** The onboarding steps the brain's folders are grouped under, by their ids in `Note.path`. */
const steps = new Set(["1 Vision", "2 Inventory"]);

/**
 * Where a note is, as crumbs that each lead somewhere: the brain; its region, which opens it in
 * the brain; for a piece of work, the team whose work it is; for something that came in, the
 * folders on the way, each to its own page when it has one; and the note itself, where you are.
 * A system, an application or a question has no region of its own: the brain, then the note.
 */
const crumbsTo = (
  shown: Note,
  vault: Folder,
  atlas: Atlas,
  brainLabel: string
): Crumb[] => {
  const crumbs: Crumb[] = [{ label: brainLabel, to: "/brain" }];
  const home = atlas.regions.find(
    (each) => each.id === atlas.home.get(shown.id)
  );
  const placed = home?.notes.find((each) => each.id === shown.id);
  const team =
    placed?.path[0] === TEAM_FOLDER
      ? home?.notes.find(
          (each) => each.kind === "team" && each.id === placed.path[1]
        )
      : undefined;
  // A group of one team is often named after it: the name is said once, for the team.
  if (home && home.name !== team?.title) {
    crumbs.push({
      label: home.name,
      to: "/brain",
      search: { region: home.id },
    });
  }
  if (team && shown.kind !== "team") {
    crumbs.push({
      label: team.title,
      to: "/brain/$noteId",
      params: { noteId: team.id },
    });
  }
  if (home?.id === "stem") {
    let folder: Folder | undefined = vault;
    for (const [depth, id] of shown.path.entries()) {
      const key = shown.path.slice(0, depth + 1).join("/");
      folder = folder?.folders.find((each) => each.key === key);
      // The stem is the region itself, and the numbered steps are how the brain fills: neither is where you are.
      const own = folder?.note;
      if (depth === 0 || steps.has(id) || own?.id === shown.id) {
        continue;
      }
      crumbs.push(
        own
          ? {
              label: folderName(id),
              to: "/brain/$noteId",
              params: { noteId: own.id },
            }
          : { label: folderName(id) }
      );
    }
  }
  crumbs.push({ label: shown.title });
  return crumbs;
};

const BrainLayout = () => {
  const { t, i18n } = useLingui();
  const loaded = Route.useLoaderData();
  const { noteId, sectionId } = useParams({ strict: false });
  const matchRoute = useMatchRoute();
  // The brain's log and its sources, each a page of its own beside the brain.
  const activity = Boolean(matchRoute({ to: "/brain/activity" }));
  const sources = Boolean(matchRoute({ to: "/brain/sources" }));
  const opportunities = Boolean(matchRoute({ to: "/brain/opportunities" }));
  const brainLabel = t`Brain`;
  if (loaded.state !== "ready") {
    return <PageNotLoaded crumbs={[{ label: brainLabel }]} page={loaded} />;
  }
  const { workspace, brain } = loaded.data;
  const atlas = atlasOf(workspace, brain);
  const note =
    noteId === undefined
      ? undefined
      : brain.notes.find((candidate) => candidate.id === noteId);
  const section = brainSections.find(
    (candidate) => candidate.slug === sectionId
  );
  let crumbs: Crumb[] = [{ label: brainLabel }];
  if (note) {
    crumbs = crumbsTo(note, folderTree(brain.notes), atlas, brainLabel);
  } else if (section) {
    crumbs = [
      { label: brainLabel, to: "/brain" },
      { label: i18n._(groupLabel[section.group]) },
    ];
  } else if (activity) {
    crumbs = [
      { label: brainLabel, to: "/brain" },
      { label: t({ message: "Activity", context: "the brain's log" }) },
    ];
  } else if (sources) {
    crumbs = [
      { label: brainLabel, to: "/brain" },
      { label: t({ message: "Sources", context: "the Brain's sources page" }) },
    ];
  } else if (opportunities) {
    crumbs = [
      { label: brainLabel, to: "/brain" },
      {
        label: t({
          message: "Opportunities",
          context: "the Brain's opportunities page",
        }),
      },
    ];
  }
  return (
    <>
      <SiteHeader
        actions={
          // A Brain page's actions; a team's or a subject's article keeps its own.
          note === undefined || onArticle(note) ? undefined : (
            <NoteActions note={note} workspace={workspace} />
          )
        }
        crumbs={crumbs}
      />
      <div {...stylex.props(styles.body)}>
        {/* The brain, a part or a note; and over them, the layer that carries the brain's dots into a note's page. */}
        <div {...stylex.props(styles.page)}>
          <Outlet />
          <NoteReveal />
        </div>
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/brain")({
  // It fills the page\'s card, its panes scrolling on their own (frame/page-fill.ts).
  staticData: { page: "fill" },
  loader: async ({
    abortController,
    context: { core },
  }): Promise<Loaded<BrainData>> => {
    const read = await readBrain(core, abortController.signal);
    if (read.state !== "ready") {
      return read;
    }
    return {
      state: "ready",
      data: { workspace: read.data, brain: buildBrain(read.data) },
    };
  },
  // No `shouldReload`: going from note to note keeps what was read (each
  // read is a page of the brain's records per type, every one in the audit
  // log), as the router reads a layout again only when it is entered; so
  // coming back to the Brain shows what the chat saved meanwhile.
  // Every page of the brain waits for this read on the way in: the
  // skeleton is the page the address names, under its bar.
  pendingComponent: BrainPending,
  component: BrainLayout,
});
