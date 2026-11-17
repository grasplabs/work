import type { Organization } from "@grasp-os/shared/organization";
import { useEffect, useState, useSyncExternalStore } from "react";

import { readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";

// The organization's name, as the sidebar shows it under the person's: read
// from core as the shell mounts, and changed at once when an admin renames
// the organization on this page (`organizationRenamed`), so the sidebar
// never shows a name the page itself just replaced. None until core says
// it, or when it has none.

/** The organization's name as the sidebar shows it. */
let shownName: string | undefined;

/** Where the organization's logo is shown from, as the sidebar shows it; none while it has none. */
let shownLogo: string | undefined;

/** How often that name was set: a sidebar shows only one set since it mounted. */
let shownVersion = 0;

/** How many renames the page saved: a read begun before one doesn't undo it. */
let renames = 0;

const listeners = new Set<() => void>();

/** Shows `name` (and `logo`, where given) as the organization's: core's answer, or a change just saved. */
const showName = (name?: string, logo?: string | null): void => {
  shownName = name;
  if (logo !== undefined) {
    shownLogo = logo ?? undefined;
  }
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

/**
 * Tells the sidebar the organization's logo changed on this page: the
 * Workspace settings call it once core saved a new one or took it away.
 */
export const organizationLogoChanged = (logo: string | null): void => {
  renames += 1;
  showName(shownName, logo);
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The organization's name and logo, or none when core couldn't say. Outside the component, as the React Compiler can't compile `try`. */
const nameOf = async (
  organization: () => Promise<Organization>
): Promise<{ name: string | undefined; logo: string | null }> => {
  try {
    const { name, logo } = await organization();
    return { name: name.trim() === "" ? undefined : name, logo };
  } catch {
    return { name: undefined, logo: null };
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
  const { name, logo } = await nameOf(organization);
  if (read.current && renames === begun) {
    showName(name, logo);
  }
};

/**
 * The organization's name as `organization` reads it once, with any
 * rename since (`organizationRenamed`); none until then, or when it has
 * none.
 */
export const useShownOrganization = (
  organization: () => Promise<Organization>
): { name: string | undefined; logo: string | undefined } => {
  // A sidebar mounted anew (another session, say) shows no name set before
  // it mounted, not even for its first paint: only one core says, or a
  // rename, since.
  // oxlint-disable-next-line react/hook-use-state -- fixed at mount, never set
  const [mountedAt] = useState(() => shownVersion);
  const version = useSyncExternalStore(subscribe, () => shownVersion);
  const name = version > mountedAt ? shownName : undefined;
  const logo = version > mountedAt ? shownLogo : undefined;
  useEffect(() => {
    const read = { current: true };
    void readName(organization, read);
    return () => {
      read.current = false;
    };
  }, [organization]);
  return { name, logo };
};

/** The organization's name alone, as `useShownOrganization` has it. */
export const useShownName = (
  organization: () => Promise<Organization>
): string | undefined => useShownOrganization(organization).name;

/** Reads the organization from core. */
export const organizationOf =
  (core: CoreConnection) => async (): Promise<Organization> =>
    await readWithin(core, async (session) => await session.organization.get());
