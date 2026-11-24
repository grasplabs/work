import type { Organization } from "@grasp-os/shared/organization";
import { useEffect, useState, useSyncExternalStore } from "react";

import { readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";

// The organization's name, under the person's at the sidebar's foot
// (frame/person-menu.tsx). Until core says the name, or when it has none,
// "Grasp". Read from core as the shell mounts, and changed at once when an
// admin renames the organization on this page (`organizationRenamed`), so
// the sidebar never shows a name the page itself just replaced.

/** The organization's name as the sidebar shows it. */
let shownName: string | undefined;

/** How often that name was set: a name shows only one set since it mounted. */
let shownVersion = 0;

/** How many renames the page saved: a read begun before one doesn't undo it. */
let renames = 0;

const listeners = new Set<() => void>();

/** Shows `name` as the organization's: core's answer, or a rename just saved. */
const showName = (name?: string): void => {
  shownName = name;
  shownVersion += 1;
  for (const listener of listeners) {
    listener();
  }
};

/**
 * Tells the sidebar the organization's name changed on this page: the
 * Workspace settings call it once core saved a new name.
 */
export const organizationRenamed = (name: string): void => {
  renames += 1;
  showName(name.trim() === "" ? undefined : name);
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The organization's name, or none when it has none or core couldn't say. Outside the component, as the React Compiler can't compile `try`. */
const nameOf = async (
  organization: () => Promise<Organization>
): Promise<string | undefined> => {
  try {
    const { name } = await organization();
    return name.trim() === "" ? undefined : name;
  } catch {
    return undefined;
  }
};

/**
 * Shows the organization's name as `organization` reads it, while `read`
 * is current and no rename was saved meanwhile: a rename is newer than any
 * read begun before it. Outside the component, as `nameOf` is.
 */
const readName = async (
  organization: () => Promise<Organization>,
  read: { current: boolean }
): Promise<void> => {
  const begun = renames;
  const named = await nameOf(organization);
  if (read.current && renames === begun) {
    showName(named);
  }
};

/**
 * The organization's name, read once with `organization`, with any rename
 * since (`organizationRenamed`): "Grasp" until then, or when it has none.
 */
export const OrganizationNameOf = ({
  organization,
}: {
  organization: () => Promise<Organization>;
}) => {
  // A name mounted anew (another session, say) shows no name set before
  // it mounted, not even for its first paint: only one core says, or a
  // rename, since.
  // oxlint-disable-next-line react/hook-use-state -- fixed at mount, never set
  const [mountedAt] = useState(() => shownVersion);
  const version = useSyncExternalStore(subscribe, () => shownVersion);
  const name = version > mountedAt ? shownName : undefined;
  useEffect(() => {
    const read = { current: true };
    void readName(organization, read);
    return () => {
      read.current = false;
    };
  }, [organization]);
  return <span data-slot="organization-name">{name ?? "Grasp"}</span>;
};

/** The organization's name, read from core once. */
export const OrganizationName = ({ core }: { core: CoreConnection }) => (
  <OrganizationNameOf
    organization={async () =>
      await readWithin(
        core,
        async (session) => await session.organization.get()
      )
    }
  />
);
