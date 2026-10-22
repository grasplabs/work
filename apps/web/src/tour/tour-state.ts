import { useSyncExternalStore } from "react";

// Where Stephen's tour stands in this tab: offered on Chat (`invited`),
// begun with his question whether the person is ready (`opening`), under
// way at a stop (`running`), or not there. The tour layer shows it and the
// person menu starts it. Whether it was offered, and whether it was taken,
// is kept in this browser's storage as the prototype keeps it
// (grasplabs/prototype `data/tour.ts`), one entry per person, as the theme
// is (frame/theme.ts), so someone else signing in here is offered it too.

export type TourPhase = "idle" | "invited" | "opening" | "running";

export interface TourState {
  phase: TourPhase;
  /** The stop he is at, by its place in the tour; -1 before the first. */
  stop: number;
  /** The page the person was on when the tour took them to Chat. */
  from: string | null;
}

const idle: TourState = { phase: "idle", stop: -1, from: null };

let state: TourState = idle;
const listeners = new Set<() => void>();
/** Offered in this visit already, to these people: once is enough. */
const asked = new Set<string>();

/** Offered, and not taken; or taken, to its end or not. */
type Kept = "seen" | "taken";

const keyOf = (userId: string): string => `grasp-tour:${userId}`;

const readKept = (userId: string): Kept | null => {
  try {
    const kept = localStorage.getItem(keyOf(userId));
    return kept === "seen" || kept === "taken" ? kept : null;
  } catch {
    // Storage blocked: it counts as not offered, and `asked` holds it to once a visit.
    return null;
  }
};

const keep = (userId: string, kept: Kept): void => {
  try {
    localStorage.setItem(keyOf(userId), kept);
  } catch {
    // Storage blocked: it lasts for this visit.
  }
};

export const setTour = (next: Partial<TourState>): void => {
  state = { ...state, ...next };
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useTour = (): TourState =>
  useSyncExternalStore(subscribe, () => state);

/** Where the tour stands, read once. */
export const tourState = (): TourState => state;

/** Whether `userId` was offered the tour in this browser or this visit. */
export const tourSeen = (userId: string): boolean => readKept(userId) !== null;

/** Whether `userId` was offered the tour in this visit already. */
export const tourAsked = (userId: string): boolean => asked.has(userId);

/** Whether `userId` took the tour in this browser: the menu offers it "again". */
export const tourTaken = (userId: string): boolean =>
  readKept(userId) === "taken";

/** The tour was offered to `userId`: taken or not, it isn't offered again by itself. */
export const tourOffered = (userId: string): void => {
  asked.add(userId);
  if (readKept(userId) === null) {
    keep(userId, "seen");
  }
};

/** `userId` said they are ready: from now on they took it. */
export const tourBegun = (userId: string): void => {
  asked.add(userId);
  keep(userId, "taken");
  setTour({ phase: "running", stop: 0 });
};

/**
 * Starts the tour from the beginning, from the offer on Chat or the
 * person menu on any page (`from`): the layer takes them to Chat, where
 * he asks whether they are ready.
 */
export const startTour = (userId: string, from: string): void => {
  if (state.phase === "opening" || state.phase === "running") {
    return;
  }
  tourOffered(userId);
  setTour({ phase: "opening", stop: -1, from: from === "/" ? null : from });
};

/** The tour is over, wherever it was. */
export const endTour = (): void => {
  setTour(idle);
};
