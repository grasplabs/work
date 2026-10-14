import { useLingui } from "@lingui/react/macro";
import {
  createFileRoute,
  Outlet,
  useParams,
  useSearch,
} from "@tanstack/react-router";

import { folderHolding, regionGroups } from "../brain/atlas-map.ts";
import { atlasOf, isRegion, REGIONS } from "../brain/brain-atlas.ts";
import type { Atlas, Region, RegionId } from "../brain/brain-atlas.ts";
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

/** The Playbook steps the brain's folders are grouped under, by their ids in `Note.path`. */
const steps = new Set(["1 Vision", "2 Inventory"]);

/** Every note in a folder, its own and those of the folders in it. */
const notesIn = (folder: Folder): Note[] => [
  ...(folder.note ? [folder.note] : []),
  ...folder.notes,
  ...folder.folders.flatMap(notesIn),
];

/** Where a folder without a page of its own leads: the part of the atlas its notes live in, or the whole brain when they are spread over several. */
const folderCrumb = (
  label: string,
  folder: Folder | undefined,
  atlas: Atlas
): Crumb => {
  const regions = [
    ...new Set<RegionId>(
      folder
        ? notesIn(folder).flatMap((each) => atlas.home.get(each.id) ?? [])
        : []
    ),
  ];
  const [only] = regions;
  return regions.length === 1 && only
    ? { label, to: "/brain", search: { region: only } }
    : { label, to: "/brain" };
};

/**
 * Where a note is, as crumbs that each lead somewhere: the brain; its part, which opens the
 * part's page; every folder on the way, to its own note when it has one, else to the part of
 * the brain its notes live in, or the whole brain when they are spread over several; and the
 * note itself, where you are. The numbered steps are how the brain fills, not where you are:
 * they are left out.
 */
const crumbsTo = (
  shown: Note,
  vault: Folder,
  atlas: Atlas,
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
      crumbs.push(folderCrumb(label, folder, atlas));
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

/** On the brain itself: the part of it that is open, the folder it is narrowed to, and the note in hand there, as its address holds them. */
interface AtlasAt {
  region: Region;
  group?: { key: string; label: string };
  inHand?: Note;
}

/** Brain, the part, the folder it is narrowed to, and the note in hand: each but the last leads back to itself. */
const regionCrumbs = (
  { region, group, inHand }: AtlasAt,
  brainLabel: string,
  regionLabel: string
): Crumb[] => {
  const crumbs: Crumb[] = [
    { label: brainLabel, to: "/brain" },
    { label: regionLabel, to: "/brain", search: { region: region.id } },
  ];
  if (group) {
    crumbs.push({
      label: group.label,
      to: "/brain",
      search: { region: region.id, group: group.key },
    });
  }
  if (inHand) {
    crumbs.push({ label: inHand.title });
  }
  const last = crumbs.at(-1);
  if (last) {
    crumbs[crumbs.length - 1] = { label: last.label };
  }
  return crumbs;
};

/** The part of the atlas open at this address, if any. */
const atlasAt = (
  search: { region?: unknown; group?: unknown; note?: unknown },
  brain: Brain,
  atlas: Atlas
): AtlasAt | undefined => {
  const inHand =
    typeof search.note === "string"
      ? brain.notes.find((candidate) => candidate.id === search.note)
      : undefined;
  const regionId = isRegion(search.region)
    ? search.region
    : inHand && atlas.home.get(inHand.id);
  const region = REGIONS.find((each) => each.id === regionId);
  if (!region) {
    return undefined;
  }
  // The folder the region is narrowed to: as asked, or the one the note in hand opens it to, as the brain itself does.
  const groupKey =
    typeof search.group === "string"
      ? search.group
      : inHand && folderHolding(region.id, atlas, brain, inHand.id);
  const group = regionGroups(region.id, atlas).find(
    (each) => each.key === groupKey
  );
  return { region, group, inHand };
};

const BrainLayout = () => {
  const { t, i18n } = useLingui();
  const loaded = Route.useLoaderData();
  const { noteId, sectionId } = useParams({ strict: false });
  const search = useSearch({ strict: false });
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
  const onAtlas =
    noteId === undefined && !section
      ? atlasAt(search, brain, atlas)
      : undefined;
  let crumbs: Crumb[] = [{ label: brainLabel }];
  if (note) {
    crumbs = crumbsTo(
      note,
      folderTree(brain.notes),
      atlas,
      brainLabel,
      (group) => i18n._(groupLabel[group])
    );
  } else if (section) {
    crumbs = [
      { label: brainLabel, to: "/brain" },
      { label: i18n._(groupLabel[section.group]) },
    ];
  } else if (onAtlas) {
    crumbs = regionCrumbs(onAtlas, brainLabel, i18n._(onAtlas.region.label));
  }
  return (
    <>
      <SiteHeader crumbs={crumbs} />
      <div className="flex min-h-0 flex-1">
        <BrainNav brain={brain} note={note} sectionSlug={section?.slug} />
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
  // the Playbook per record type, every one in the audit log.
  shouldReload: false,
  pendingComponent: PageLoading,
  component: BrainLayout,
});
