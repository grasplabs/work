// The way from the setup into the platform, asked for by the setup's last
// screen and played by the layer the root keeps (platform-entry.tsx), so
// it lives on while the page under it changes from the setup to the
// platform. Only what to show and how to go: small, as every page loads it.

/** One thing the admin set up, as the way in shows it. */
export interface EntryFact {
  text: string;
  /** How it stands: the company in the middle, the rest around it. */
  kind: "company" | "team" | "lead" | "people" | "document" | "start";
}

export interface Entry {
  facts: EntryFact[];
  /**
   * Gets the platform's page ready while the chips gather: what it reads
   * fetched and its code loaded, so `go` builds it from what is at hand.
   */
  ready?: () => Promise<void>;
  /** Changes the page under the layer to the platform; over once it is there. */
  go: () => Promise<void>;
}

let current: Entry | null = null;
const listeners = new Set<() => void>();

const set = (next: Entry | null): void => {
  current = next;
  for (const listener of listeners) {
    listener();
  }
};

export const subscribeEntry = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const entryNow = (): Entry | null => current;

/**
 * Into the platform, as the setup's last screen asks: what the admin set
 * up gathers on the screen and builds the platform's first page. Under
 * reduced motion the page simply changes.
 */
export const enterPlatform = async (entry: Entry): Promise<void> => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    await entry.go();
    return;
  }
  set(entry);
};

/** The way in is over, or given up. */
export const entryOver = (): void => {
  set(null);
};
