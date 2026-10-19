import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { BrainIcon, Building2Icon, ChevronDownIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import {
  PageSidebar,
  PageSidebarBody,
  PageSidebarTop,
  RailButton,
  RailDivider,
  RailExpand,
  usePageSidebarFold,
} from "../frame/page-sidebar.tsx";
import { dotClass } from "./brain-colors.ts";
import { tone } from "./brain-home.tsx";
import { brainSections, findFolder, shownCount } from "./brain-sections.ts";
import { countNotes, folderTree, groupLabel } from "./brain.ts";
import type { Brain, Folder, Note } from "./brain.ts";

// The brain's navigation, as the prototype has it (`components/brain-nav.tsx`).

/** Where the parts and folders the reader opened are kept, so a reload shows them as they were. */
const opened = "grasp.brain.open";

// The folder keys the reader left open, or none where there are none yet or storage is refused.
const readOpened = (): Set<string> => {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(opened) ?? "[]");
    return new Set(
      Array.isArray(kept)
        ? kept.filter((key): key is string => typeof key === "string")
        : []
    );
  } catch {
    return new Set();
  }
};

const saveOpened = (open: Set<string>): void => {
  try {
    localStorage.setItem(opened, JSON.stringify([...open]));
  } catch {
    // See `readOpened`.
  }
};

/** The set with the key added when it was missing, removed when it was there. */
const flip = (previous: Set<string>, key: string): Set<string> => {
  const next = new Set(previous);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
};

/** The folder keys on the way to a note, so its section and sub-folders can open. */
const pathKeys = (note: Note): string[] =>
  note.path.map((_, depth) => note.path.slice(0, depth + 1).join("/"));

const chevron = (expanded: boolean): string =>
  expanded
    ? "text-muted-foreground size-3.5 transition-transform"
    : "text-muted-foreground size-3.5 -rotate-90 transition-transform";

const NoteItem = ({ note }: { note: Note }) => (
  <Link
    className="text-muted-foreground hover:bg-accent hover:text-foreground data-[status=active]:bg-accent data-[status=active]:text-foreground flex items-center gap-2 rounded-md px-2 py-1 text-sm data-[status=active]:font-medium"
    params={{ noteId: note.id }}
    title={note.title}
    to="/brain/$noteId"
  >
    <span
      aria-hidden="true"
      className="flex size-3 flex-none items-center justify-center"
    >
      <span className={`size-1.5 rounded-full ${dotClass(note.kind)}`} />
    </span>
    <span className="min-w-0 flex-1 truncate">{note.title}</span>
    {/* A source shows how many statements were tagged in it, since statements live there. */}
    {note.kind === "source" && note.statementIds.length > 0 ? (
      <span className="text-xs tabular-nums">{note.statementIds.length}</span>
    ) : null}
  </Link>
);

interface Opening {
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
}

/** A group in a part, as a heading with its count; what it holds, while open, under it. */
const Group = ({
  folder,
  opening,
  children,
}: {
  folder: Folder;
  opening: Opening;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const expanded = opening.isOpen(folder.key);
  const page = folder.note;
  const name = page?.title ?? folder.name;
  const heading =
    "text-foreground min-w-0 flex-1 truncate text-left text-sm data-[status=active]:font-medium";
  return (
    <div className="flex flex-col gap-0.5 pt-1">
      <div className="hover:bg-accent has-data-[status=active]:bg-accent flex items-center gap-1 rounded-md px-2 py-1">
        {page ? (
          // A group with its own page, such as a source folder, opens it from its name; the arrow folds it.
          <Link
            className={heading}
            params={{ noteId: page.id }}
            to="/brain/$noteId"
          >
            {name}
          </Link>
        ) : (
          <button
            aria-expanded={expanded}
            className={heading}
            onClick={() => {
              opening.toggle(folder.key);
            }}
            type="button"
          >
            {name}
          </button>
        )}
        <span className="text-muted-foreground text-xs tabular-nums">
          {countNotes(folder) - (page ? 1 : 0)}
        </span>
        <button
          aria-expanded={expanded}
          aria-label={expanded ? t`Close ${name}` : t`Open ${name}`}
          className="flex size-5 flex-none items-center justify-center rounded-sm"
          onClick={() => {
            opening.toggle(folder.key);
          }}
          type="button"
        >
          <ChevronDownIcon className={chevron(expanded)} />
        </button>
      </div>
      {children}
    </div>
  );
};

/**
 * What a part holds, along its one guide line: its notes, and its groups as headings over theirs.
 * There is one kind of heading and one level of it, so the list reads in two styles only: a group
 * in full colour and a note in the quieter one, all in the same size. A group that only holds other
 * groups, such as Conversations, steps aside for them. Nothing indents further, so every title
 * starts in the same place.
 */
const Entries = ({ folder, opening }: { folder: Folder; opening: Opening }) => (
  <>
    {folder.notes.map((note) => (
      <NoteItem key={note.id} note={note} />
    ))}
    {folder.folders.map((child) =>
      child.notes.length === 0 && child.folders.length > 0 ? (
        <Entries folder={child} key={child.key} opening={opening} />
      ) : (
        <Group folder={child} key={child.key} opening={opening}>
          {opening.isOpen(child.key) ? (
            <Entries folder={child} opening={opening} />
          ) : null}
        </Group>
      )
    )}
  </>
);

const topLinkClass =
  "group hover:bg-accent data-[status=active]:bg-accent flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm data-[status=active]:font-medium";

const TopLinkContent = ({
  icon: Icon,
  label,
}: {
  icon: LucideIcon;
  label: string;
}) => (
  <>
    <Icon className="text-muted-foreground group-data-[status=active]:text-foreground size-4 flex-none" />
    <span className="min-w-0 flex-1 truncate">{label}</span>
  </>
);

/** The home and the web, above the parts: an icon and a name. Without a note it is the web. */
const TopLink = ({
  to,
  icon,
  label,
}: {
  to?: string;
  icon: LucideIcon;
  label: string;
}) =>
  to === undefined ? (
    <Link activeOptions={{ exact: true }} className={topLinkClass} to="/brain">
      <TopLinkContent icon={icon} label={label} />
    </Link>
  ) : (
    <Link className={topLinkClass} params={{ noteId: to }} to="/brain/$noteId">
      <TopLinkContent icon={icon} label={label} />
    </Link>
  );

/**
 * The brain's navigation: the home and the brain itself, then one entry per part of the brain with
 * its icon, which opens in place to its notes along a thin guide line. It folds to a rail of icons
 * to give the page more room: by itself on a window too narrow to hold it open beside the brain,
 * and whenever you fold it. It stays folded or open as the reader left it, and so do the parts and
 * folders opened in it.
 */
export const BrainNav = ({
  brain,
  note,
  sectionSlug,
}: {
  brain: Brain;
  note?: Note;
  sectionSlug?: string;
}) => {
  const { t, i18n } = useLingui();
  const [collapsed, setCollapsed] = usePageSidebarFold("brain");
  const [open, setOpen] = useState(readOpened);
  // What is open is kept for the next visit, as the folding is.
  useEffect(() => {
    saveOpened(open);
  }, [open]);
  const [revealed, setRevealed] = useState<string | undefined>();
  const company = brain.notes.find((candidate) => candidate.kind === "company");
  const here = new Set(note ? pathKeys(note) : []);

  // Opening a note opens the way to it once, so you can see where you are. After that it closes
  // like anything else.
  if (note && revealed !== note.id) {
    setRevealed(note.id);
    setOpen((previous) => new Set([...previous, ...pathKeys(note)]));
  }
  // A part's own page opens that part here too, once.
  const shownSection = brainSections.find(
    (section) => section.slug === sectionSlug
  );
  if (shownSection && revealed !== shownSection.slug) {
    setRevealed(shownSection.slug);
    setOpen((previous) => new Set([...previous, shownSection.key]));
  }

  const tree = folderTree(brain.notes);
  const opening: Opening = {
    isOpen: (key) => open.has(key),
    toggle: (key) => {
      setOpen((previous) => flip(previous, key));
    },
  };
  const sections = brainSections.flatMap((section) => {
    const folder = findFolder(tree, section.key);
    return folder
      ? [{ ...section, folder, label: i18n._(groupLabel[section.group]) }]
      : [];
  });

  if (collapsed) {
    return (
      <PageSidebar folded label={t`The brain`}>
        <RailExpand
          label={t`Expand the navigation`}
          onExpand={() => {
            setCollapsed(false);
          }}
        />
        <RailDivider />
        {company ? (
          <RailButton
            active={note?.id === company.id}
            label={company.title}
            render={
              <Link params={{ noteId: company.id }} to="/brain/$noteId" />
            }
          >
            <Building2Icon />
          </RailButton>
        ) : null}
        <RailButton
          active={!note && sectionSlug === undefined}
          label={t`Brain`}
          render={<Link to="/brain" />}
        >
          <BrainIcon />
        </RailButton>
        {sections.map((section) => {
          const Icon = section.icon;
          return (
            <RailButton
              active={here.has(section.key) || section.slug === sectionSlug}
              key={section.key}
              label={section.label}
              render={
                <Link
                  params={{ sectionId: section.slug }}
                  to="/brain/sections/$sectionId"
                />
              }
            >
              <Icon className={tone[section.group].ink} />
            </RailButton>
          );
        })}
      </PageSidebar>
    );
  }

  return (
    <PageSidebar folded={false} label={t`The brain`}>
      {/* The home, with the way to fold the navigation beside it: out of the way, where the panel begins. */}
      <PageSidebarTop
        fold={{
          label: t`Fold the navigation`,
          onFold: () => {
            setCollapsed(true);
          },
        }}
        joined
      >
        {company ? (
          <TopLink icon={Building2Icon} label={company.title} to={company.id} />
        ) : (
          <TopLink icon={BrainIcon} label={t`Brain`} />
        )}
      </PageSidebarTop>
      <PageSidebarBody joined>
        {company ? <TopLink icon={BrainIcon} label={t`Brain`} /> : null}
        <span aria-hidden="true" className="bg-border my-2 h-px" />

        {sections.map((section) => {
          const Icon = section.icon;
          const expanded = opening.isOpen(section.key);
          const current = here.has(section.key);
          const name = section.label;
          return (
            <div className="flex flex-col" key={section.key}>
              <div className="hover:bg-accent has-data-[status=active]:bg-accent flex items-center rounded-md">
                <Link
                  className={
                    current
                      ? "group flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-2 text-sm font-medium"
                      : "group flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-2 text-sm data-[status=active]:font-medium"
                  }
                  params={{ sectionId: section.slug }}
                  to="/brain/sections/$sectionId"
                >
                  <Icon
                    className={`size-4 flex-none ${tone[section.group].ink}`}
                  />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <span className="text-muted-foreground text-xs font-normal tabular-nums">
                    {shownCount(section.folder)}
                  </span>
                </Link>
                <button
                  aria-expanded={expanded}
                  aria-label={expanded ? t`Close ${name}` : t`Open ${name}`}
                  className="flex size-7 flex-none items-center justify-center rounded-md"
                  onClick={() => {
                    opening.toggle(section.key);
                  }}
                  type="button"
                >
                  <ChevronDownIcon className={chevron(expanded)} />
                </button>
              </div>
              {expanded ? (
                <div className="my-1 ml-4 flex flex-col gap-0.5 border-l pl-2">
                  {section.folder.note ? (
                    <NoteItem note={section.folder.note} />
                  ) : null}
                  <Entries folder={section.folder} opening={opening} />
                </div>
              ) : null}
            </div>
          );
        })}
      </PageSidebarBody>
    </PageSidebar>
  );
};
