import {
  AppWindowIcon,
  CircleHelpIcon,
  FileDocIcon,
  RocketIcon,
  UsersIcon,
  WorkflowIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";

import type { Folder, Group, Note } from "./brain.ts";

// The parts of the brain, as the prototype has them
// (`components/brain-sections.tsx`).

/** A part of the brain, as the home, the navigation and its own page show it. */
export interface BrainSection {
  /** Its address: /brain/sections/teams. */
  slug: string;
  /** Its folder's id in `Note.path`, joined with "/". */
  key: string;
  group: Group;
  icon: IconData;
}

export const brainSections: BrainSection[] = [
  {
    slug: "vision",
    key: "1 Vision",
    group: "vision",
    icon: RocketIcon,
  },
  {
    slug: "teams",
    key: "2 Inventory/Teams",
    group: "teams",
    icon: UsersIcon,
  },
  {
    slug: "workflows",
    key: "2 Inventory/Candidates",
    group: "candidates",
    icon: WorkflowIcon,
  },
  {
    slug: "tools",
    key: "2 Inventory/Tools",
    group: "tools",
    icon: AppWindowIcon,
  },
  {
    slug: "gaps",
    key: "2 Inventory/Gaps",
    group: "gaps",
    icon: CircleHelpIcon,
  },
  {
    slug: "sources",
    key: "Sources",
    group: "sources",
    icon: FileDocIcon,
  },
];

export const findFolder = (folder: Folder, key: string): Folder | undefined => {
  if (folder.key === key) {
    return folder;
  }
  for (const child of folder.folders) {
    const found = findFolder(child, key);
    if (found) {
      return found;
    }
  }
  return undefined;
};

/** A run of notes under one heading on a part's page; the first run has no heading. */
interface NoteGroup {
  key: string;
  name?: string;
  /** The group's own page, such as a source folder's. */
  page?: Note;
  notes: Note[];
}

/** Every note in a folder, its sub-folders' pages and notes included, in order. */
const allNotes = (folder: Folder): Note[] => [
  ...(folder.note ? [folder.note] : []),
  ...folder.notes,
  ...folder.folders.flatMap(allNotes),
];

/** A folder that holds only other folders, such as Conversations: it steps aside for them. */
export const onlyGroups = (folder: Folder): boolean =>
  folder.notes.length === 0 && folder.folders.length > 0;

/** The groups under a folder, one level deep: a folder that only holds groups gives way to them. */
const groupsIn = (parent: Folder): NoteGroup[] =>
  parent.folders.flatMap((child) =>
    onlyGroups(child)
      ? groupsIn(child)
      : [
          {
            key: child.key,
            name: child.note?.title ?? child.name,
            ...(child.note ? { page: child.note } : {}),
            notes: [...child.notes, ...child.folders.flatMap(allNotes)],
          },
        ]
  );

/**
 * A part's notes as its page shows them: its own first, then one group per sub-folder. A folder that
 * only holds other folders, such as Conversations, steps aside for them, so there is one level of
 * group, as in the navigation. Such a folder's own page, a list of the groups shown right there
 * anyway, is left out.
 */
export const noteGroups = (folder: Folder): NoteGroup[] => {
  const own: NoteGroup = {
    key: folder.key,
    notes: [...(folder.note ? [folder.note] : []), ...folder.notes],
  };
  return [own, ...groupsIn(folder)].filter(
    (group) => group.notes.length > 0 || group.page !== undefined
  );
};

/** How many notes a part's page shows, which is the count the home and the navigation give it too. */
export const shownCount = (folder: Folder): number =>
  noteGroups(folder).reduce(
    (sum, group) => sum + group.notes.length + (group.page ? 1 : 0),
    0
  );
