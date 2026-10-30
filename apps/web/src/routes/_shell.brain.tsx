import { useLingui } from "@lingui/react/macro";
import {
  createFileRoute,
  Outlet,
  useMatchRoute,
  useParams,
  useSearch,
} from "@tanstack/react-router";

import { atlasOf, isRegion, TEAM_FOLDER } from "../brain/brain-atlas.ts";
import type { Atlas, RegionId } from "../brain/brain-atlas.ts";
import type { BrainData } from "../brain/brain-data.ts";
import { BrainNav } from "../brain/brain-nav.tsx";
import { brainSections } from "../brain/brain-sections.ts";
import {
  buildBrain,
  folderName,
  folderTree,
  groupLabel,
} from "../brain/brain.ts";
import type { Brain, Folder, Note } from "../brain/brain.ts";
import { NoteReveal } from "../brain/note-reveal.tsx";
import { readBrain } from "../brain/read-brain.ts";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import type { Crumb } from "../frame/site-header.tsx";
import type { Loaded } from "../load-from-core.tsx";

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

/**
 * The part of the atlas open at this address, if any: as asked, or the one
 * the note in hand sits in. Its navigation opens to it; the way back through
 * it stands on the canvas (`AtlasTrail`), not in the header: one trail, not
 * two, as the prototype has it.
 */
const atlasRegion = (
  search: { region?: unknown; note?: unknown },
  brain: Brain,
  atlas: Atlas
): RegionId | undefined => {
  const inHand =
    typeof search.note === "string"
      ? brain.notes.find((candidate) => candidate.id === search.note)
      : undefined;
  const regionId = isRegion(search.region)
    ? search.region
    : inHand && atlas.home.get(inHand.id);
  return atlas.regions.find((each) => each.id === regionId)?.id;
};

const BrainLayout = () => {
  const { t, i18n } = useLingui();
  const loaded = Route.useLoaderData();
  const { noteId, sectionId } = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const matchRoute = useMatchRoute();
  // The brain's log and its memory records, each a page of its own beside the brain.
  const activity = Boolean(matchRoute({ to: "/brain/activity" }));
  const memory = Boolean(matchRoute({ to: "/brain/memory" }));
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
  const region =
    noteId === undefined && !section
      ? atlasRegion(search, brain, atlas)
      : undefined;
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
  } else if (memory) {
    crumbs = [{ label: brainLabel, to: "/brain" }, { label: t`Memory` }];
  }
  return (
    <>
      <SiteHeader crumbs={crumbs} />
      <div className="flex min-h-0 flex-1">
        <BrainNav atlas={atlas} brain={brain} note={note} region={region} />
        {/* The brain, a part or a note; and over them, the layer that carries the brain's dots into a note's page. */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <Outlet />
          <NoteReveal />
        </div>
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/brain")({
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
  // Going from note to note keeps what was read: each read is a page of
  // the brain's records per type, every one in the audit log.
  shouldReload: false,
  pendingComponent: PageLoading,
  component: BrainLayout,
});
