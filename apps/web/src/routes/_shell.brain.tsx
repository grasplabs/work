import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";

import type { BrainData } from "../brain/brain-data.ts";
import { BrainNav } from "../brain/brain-nav.tsx";
import { brainSections } from "../brain/brain-sections.ts";
import {
  buildBrain,
  folderName,
  folderTree,
  groupLabel,
} from "../brain/brain.ts";
import type { Folder, Note } from "../brain/brain.ts";
import { readBrain } from "../brain/read-brain.ts";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import type { Crumb } from "../frame/site-header.tsx";
import type { Loaded } from "../load-from-core.tsx";

// The Brain, as the prototype lays it out (`routes/brain.tsx`): its
// navigation on the left; on the right its home, a part's page, or one
// note. The workspace is read once on the way in and built into the brain
// here, in the person's language: switching language reads it again
// (main.tsx), and so does anything that invalidates the router.

/** The Playbook steps the brain's folders are grouped under, by their ids in `Note.path`. */
const steps = new Set(["1 Vision", "2 Inventory"]);

/**
 * Where a note is, as crumbs that each lead somewhere: the brain; its part, which opens the
 * part's page; every folder on the way, to its own note when it has one, else to the brain; and
 * the note itself, where you are. The numbered steps are how the brain fills, not where you are:
 * they are left out.
 */
const crumbsTo = (
  shown: Note,
  vault: Folder,
  brainLabel: string,
  partLabel: (group: (typeof brainSections)[number]["group"]) => string
): Crumb[] => {
  const crumbs: Crumb[] = [{ label: brainLabel, to: "/brain" }];
  let folder: Folder | undefined = vault;
  for (const [depth, id] of shown.path.entries()) {
    const key = shown.path.slice(0, depth + 1).join("/");
    folder = folder?.folders.find((each) => each.key === key);
    const part = brainSections.find((candidate) => candidate.key === key);
    if (part) {
      crumbs.push({
        label: partLabel(part.group),
        to: "/brain/sections/$sectionId",
        params: { sectionId: part.slug },
      });
      continue;
    }
    if (steps.has(id)) {
      continue;
    }
    const label = folderName(id);
    const own = folder?.note;
    if (own?.id === shown.id) {
      // The folder's own page: it is where you are.
      crumbs.push({ label });
    } else if (own) {
      crumbs.push({ label, to: "/brain/$noteId", params: { noteId: own.id } });
    } else {
      // In the prototype a folder without a page of its own leads to the part of the atlas its notes
      // live in; until the atlas is here, to the brain.
      crumbs.push({ label, to: "/brain" });
    }
  }
  // A folder's own page, such as a source folder, is named after its folder: say it once.
  if (
    !(
      shown.path.length > 0 &&
      folderName(shown.path.at(-1) ?? "") === shown.title
    )
  ) {
    crumbs.push({ label: shown.title });
  }
  return crumbs;
};

const BrainLayout = () => {
  const { t, i18n } = useLingui();
  const loaded = Route.useLoaderData();
  const { noteId, sectionId } = useParams({ strict: false });
  const brainLabel = t`Brain`;
  if (loaded.state !== "ready") {
    return <PageNotLoaded crumbs={[{ label: brainLabel }]} page={loaded} />;
  }
  const { brain } = loaded.data;
  const note =
    noteId === undefined
      ? undefined
      : brain.notes.find((candidate) => candidate.id === noteId);
  const section = brainSections.find(
    (candidate) => candidate.slug === sectionId
  );
  const partCrumbs: Crumb[] = section
    ? [
        { label: brainLabel, to: "/brain" },
        { label: i18n._(groupLabel[section.group]) },
      ]
    : [{ label: brainLabel }];
  const crumbs = note
    ? crumbsTo(note, folderTree(brain.notes), brainLabel, (group) =>
        i18n._(groupLabel[group])
      )
    : partCrumbs;
  return (
    <>
      <SiteHeader crumbs={crumbs} />
      <div className="flex min-h-0 flex-1">
        <BrainNav brain={brain} note={note} sectionSlug={section?.slug} />
        {/* The brain's home, a part or a note. */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <Outlet />
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
  // the Playbook per record type, every one in the audit log.
  shouldReload: false,
  pendingComponent: PageLoading,
  component: BrainLayout,
});
