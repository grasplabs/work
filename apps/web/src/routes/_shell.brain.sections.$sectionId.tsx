import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BrainIcon } from "lucide-react";

import { BackButton } from "../brain/back-button.tsx";
import { tintClass } from "../brain/brain-colors.ts";
import { useBrainData } from "../brain/brain-data.ts";
import { Panel, tone } from "../brain/brain-home.tsx";
import {
  brainSections,
  findFolder,
  noteGroups,
  shownCount,
} from "../brain/brain-sections.ts";
import type { BrainSection } from "../brain/brain-sections.ts";
import { folderTree, groupLabel } from "../brain/brain.ts";
import type { Note, NoteKind } from "../brain/brain.ts";
import { AppLogo } from "../connections/app-logo.tsx";
import { NotFoundState } from "../frame/page-states.tsx";

// One part of the brain on its own page, as the prototype has it
// (`routes/brain/sections.$sectionId.tsx`).

/** The kind whose colour a part's page takes. */
const sectionKind: Record<BrainSection["group"], NoteKind> = {
  vision: "vision",
  teams: "team",
  candidates: "candidate",
  tools: "tool",
  gaps: "gap",
  sources: "source",
  company: "company",
  statements: "statement",
};

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
}) => {
  const Icon = section.icon;
  return (
    <Link
      className="group flex min-w-0 flex-col gap-3"
      params={{ noteId: note.id }}
      to="/brain/$noteId"
    >
      <Panel group={section.group} short>
        {note.kind === "tool" || note.kind === "app" ? (
          <AppLogo name={note.title} size="lg" />
        ) : (
          <span className="bg-card flex size-14 items-center justify-center rounded-2xl border shadow-xs">
            <Icon className={`size-6 ${tone[section.group].ink}`} />
          </span>
        )}
      </Panel>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-sm font-medium group-hover:underline">
          {note.title}
        </span>
        <span className="text-muted-foreground line-clamp-2 text-sm leading-relaxed">
          {note.summary}
        </span>
      </span>
    </Link>
  );
};

/**
 * One part of the brain on its own page, such as Teams: what it holds, then a block for each of
 * its notes to open, under a heading for each group when it has groups.
 */
const SectionPage = () => {
  const { t, i18n } = useLingui();
  const { sectionId } = Route.useParams();
  const { brain } = useBrainData();
  const section = brainSections.find(
    (candidate) => candidate.slug === sectionId
  );
  const folder = section
    ? findFolder(folderTree(brain.notes), section.key)
    : undefined;

  if (!section || !folder) {
    return (
      <NotFoundState icon={BrainIcon} title={t`Part of the brain not found`} />
    );
  }

  const Icon = section.icon;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pt-8 pb-24 md:px-12">
        <header className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <BackButton />
            <span
              className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ${tintClass(sectionKind[section.group])}`}
            >
              <Icon className="size-3.5" />
              {shownCount(folder)}
            </span>
          </div>
          <h1 className="text-2xl font-medium tracking-tight">
            {i18n._(groupLabel[section.group])}
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {i18n._(section.description)}
          </p>
        </header>
        {noteGroups(folder).map((group) => (
          <section className="flex flex-col gap-3" key={group.key}>
            {group.name === undefined ? null : (
              <h2 className="flex items-baseline gap-2 text-sm font-medium">
                {group.page ? (
                  <Link
                    className="hover:underline"
                    params={{ noteId: group.page.id }}
                    to="/brain/$noteId"
                  >
                    {group.name}
                  </Link>
                ) : (
                  group.name
                )}
                <span className="text-muted-foreground font-normal tabular-nums">
                  {group.notes.length}
                </span>
              </h2>
            )}
            <div className="grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-2 xl:grid-cols-3">
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
