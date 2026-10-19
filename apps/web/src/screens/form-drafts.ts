import { screenLimits } from "@grasp-os/shared/screens";
import { z } from "zod";

// The page's keep of a person's unsaved record-form drafts (GRA-254), for
// the screens it frames: the frame has an opaque origin and no storage, so
// the page keeps what its session client hands over (`@grasp-os/sdk`'s
// form-drafts.ts), in the tab's session storage, so that a refresh of the
// tab finds them again. Nothing else reads them.
//
// Session storage is not gone when the tab is: a browser may write it to
// disk and bring it back after a crash, with "continue where you left off",
// or when a closed tab is reopened. What guards a restored tab is the
// sweep whenever the page learns who is signed in (`sweepDrafts`): nobody,
// and every draft goes; someone, and every draft not theirs goes, and every
// expired one. Drafts are never relied on to end with the tab.
//
// Everything a frame sends is untrusted. Failure modes, and how each is
// closed:
//
// - A frame reads or writes another App's drafts, or another person's:
//   each person's drafts of each App are one entry, named by the person
//   core says is signed in and the App the frame's bridge is bound to,
//   never by the frame.
// - Drafts outlive their person: the shell sweeps at every start and when
//   core says who is signed in; a session that ends (signed out here or
//   elsewhere, expired, revoked, someone else signed in) stops all draft
//   writes and drops every draft before the page reloads (`stopDrafts`).
// - Drafts outlive access: a screen the page refuses to open, or whose
//   calls core refuses for the person or the App, drops its App's drafts
//   and keeps no more (`appDrafts`), whatever the frame does; the frame's
//   client drops them too at a fence.
// - A frame fills the storage, or crowds out another App's drafts: each
//   draft, key, App's count and App's share of the tab are bounded
//   (`screenLimits.drafts`); past its own bounds an App loses its own
//   oldest drafts, and past the tab's total the oldest draft in the tab
//   goes, whichever App's it is, so no App can empty another's.

/** The storage keys of drafts start with this. */
const prefix = "grasp.form-drafts:";

/** `<prefix><person>:<app>`, each id encoded so neither can hold the `:`. */
const keyOf = (person: string, app: string): string =>
  `${prefix}${encodeURIComponent(person)}:${encodeURIComponent(app)}`;

/** Whose drafts of which App `key` holds, or undefined for a key not made by `keyOf`. */
const ownerOf = (
  key: string
): { readonly person: string; readonly app: string } | undefined => {
  const [person, app, ...rest] = key.slice(prefix.length).split(":");
  if (person === undefined || app === undefined || rest.length > 0) {
    return undefined;
  }
  try {
    return {
      person: decodeURIComponent(person),
      app: decodeURIComponent(app),
    };
  } catch {
    return undefined;
  }
};

/** One kept draft: its text and when it was written. */
const keptSchema = z.object({ text: z.string(), at: z.number() });

type Kept = z.infer<typeof keptSchema>;

/** One person's drafts of one App, by the frame's name for each. */
type Drafts = Map<string, Kept>;

/** The tab's storage, or none in a window that refuses it. */
const storage = (): Storage | undefined => {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
};

/** Every storage key of drafts in `store`. */
const draftKeys = (store: Storage): string[] => {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key?.startsWith(prefix) === true) {
      keys.push(key);
    }
  }
  return keys;
};

/** The drafts kept under `key`, those still young enough, now. */
const read = (store: Storage, key: string, now: number): Drafts => {
  const drafts: Drafts = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(store.getItem(key) ?? "{}");
  } catch {
    return drafts;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return drafts;
  }
  for (const [name, value] of Object.entries(parsed)) {
    const kept = keptSchema.safeParse(value);
    if (kept.success && now - kept.data.at <= screenLimits.drafts.maxAgeMs) {
      drafts.set(name, kept.data);
    }
  }
  return drafts;
};

const textOf = (drafts: Drafts): string =>
  JSON.stringify(Object.fromEntries(drafts));

/** Characters kept of every draft in `store`, each entry's text. */
const totalOf = (store: Storage): number =>
  draftKeys(store).reduce(
    (total, key) => total + (store.getItem(key)?.length ?? 0),
    0
  );

/** The name of the oldest of `drafts`, by when it was written. */
const oldestOf = (drafts: Drafts): [string, Kept] | undefined => {
  let oldest: [string, Kept] | undefined;
  for (const entry of drafts) {
    if (oldest === undefined || entry[1].at < oldest[1].at) {
      oldest = entry;
    }
  }
  return oldest;
};

/**
 * Writes `drafts` as `key` as they are: removed once empty, and left as
 * it is when that is what it holds already, so a frame's lookups, each a
 * sweep of the tab, never rewrite every App's drafts.
 */
const put = (store: Storage, key: string, drafts: Drafts): void => {
  if (drafts.size === 0) {
    store.removeItem(key);
    return;
  }
  const text = textOf(drafts);
  if (store.getItem(key) !== text) {
    store.setItem(key, text);
  }
};

/**
 * Drops the oldest draft in the tab: of `drafts` (what is being written
 * as `key`) or of any other App's entry, whichever was written first.
 */
const dropOldestInTab = (
  store: Storage,
  key: string,
  drafts: Drafts,
  now: number
): void => {
  let oldest: { key: string; name: string; at: number } | undefined;
  const consider = (entryKey: string, entries: Drafts): void => {
    const found = oldestOf(entries);
    if (
      found !== undefined &&
      (oldest === undefined || found[1].at < oldest.at)
    ) {
      oldest = { key: entryKey, name: found[0], at: found[1].at };
    }
  };
  consider(key, drafts);
  for (const other of draftKeys(store)) {
    if (other !== key) {
      consider(other, read(store, other, now));
    }
  }
  if (oldest === undefined || oldest.key === key) {
    drafts.delete(oldest?.name ?? "");
    return;
  }
  const theirs = read(store, oldest.key, now);
  theirs.delete(oldest.name);
  try {
    put(store, oldest.key, theirs);
  } catch {
    // Smaller than it was, so it fits; if not, it goes whole.
    store.removeItem(oldest.key);
  }
};

/** How many storage steps of drafts ran: what a cache of them is checked by. */
let storageSteps = 0;

/**
 * Runs `run` on the tab's storage, best effort: a browser may refuse it
 * (full, or blocked) at any step, and the page goes on, a sign-out or a
 * check of core's status included. Each draft entry is its own step, so
 * one that fails leaves the rest to be dropped.
 */
const quietly = (run: () => void): void => {
  storageSteps += 1;
  try {
    run();
  } catch {
    // What couldn't be written stays as it was; the next sweep tries again.
  }
};

/** Every storage key of drafts in `store`, or none when it can't be read. */
const keysOf = (store: Storage): string[] => {
  try {
    return draftKeys(store);
  } catch {
    return [];
  }
};

/** Deletes every expired draft in the tab but `key`'s, which is being written. */
const pruneExpired = (store: Storage, key: string, now: number): void => {
  for (const other of keysOf(store)) {
    if (other !== key) {
      quietly(() => {
        put(store, other, read(store, other, now));
      });
    }
  }
};

/** Whether `error` is the browser saying its storage is full. */
const overRoom = (error: unknown): boolean =>
  error instanceof DOMException &&
  (error.name === "QuotaExceededError" ||
    error.name === "NS_ERROR_DOM_QUOTA_REACHED");

/**
 * Writes `drafts` as `key`: first within an App's own count and share,
 * losing its own oldest; then within the tab's total and the browser's
 * room, losing the oldest draft in the tab.
 */
const write = (
  store: Storage,
  key: string,
  drafts: Drafts,
  now: number
): void => {
  // The browser's storage full of what isn't drafts, or a draft too large
  // for it: only this App's own drafts go then, never another's.
  let full = false;
  let pruned = false;
  while (
    drafts.size > screenLimits.drafts.perApp ||
    textOf(drafts).length > screenLimits.drafts.appCharacters
  ) {
    const oldest = oldestOf(drafts);
    if (oldest === undefined) {
      break;
    }
    drafts.delete(oldest[0]);
  }
  for (;;) {
    if (drafts.size === 0) {
      store.removeItem(key);
      return;
    }
    const text = textOf(drafts);
    const others = totalOf(store) - (store.getItem(key)?.length ?? 0);
    if (others + text.length <= screenLimits.drafts.total) {
      try {
        store.setItem(key, text);
        return;
      } catch (error) {
        // Over the browser's room: the oldest goes, as past `total`. Any
        // other refusal no deletion can fix: nothing else is touched.
        if (!overRoom(error)) {
          throw error;
        }
        full = true;
      }
    }
    if (full) {
      drafts.delete(oldestOf(drafts)?.[0] ?? "");
    } else if (pruned) {
      dropOldestInTab(store, key, drafts, now);
    } else {
      // Expired drafts count towards the total until they are deleted:
      // first they go, then, if still past it, the oldest live one.
      pruned = true;
      pruneExpired(store, key, now);
    }
  }
};

/** Room kept in a message for what surrounds the drafts handed over. */
const handedOverOverhead = 1024;

/**
 * Every running screen's drafts, by App, as each is shut: a refusal of
 * the person or the App one screen hears is every screen's of that App.
 */
const shutters = new Map<string, Set<() => void>>();

/** Whether the page keeps drafts at all: not once the session ended. */
let stopped = false;

/** Whether the session ended: drafts are never kept again in this page. */
let ended = false;

/** Sign-outs on their way: drafts are kept again once none is, unless it ended. */
let signingOut = 0;

/**
 * What the running screens' drafts hold back while a sign-out is on its
 * way: each resumes writing it once that sign-out failed.
 */
const resumers = new Set<(person: string) => void>();

/**
 * A sign-out failed, which doesn't say the session is still the person's
 * (core may have ended it before its answer was lost): drafts are kept
 * again only once core says who is signed in (`sweepDrafts`).
 */
let unconfirmed = false;

/**
 * The page learned who is signed in (`person`, or nobody): every draft not
 * theirs goes, and every expired one, deleted rather than skipped.
 */
export const sweepDrafts = (person?: string, now = Date.now()): void => {
  if (unconfirmed && signingOut === 0 && !ended) {
    unconfirmed = false;
    if (person === undefined) {
      // Signed out after all: none is kept again, and the sweep below
      // drops every one.
      ended = true;
    } else {
      stopped = false;
      for (const resume of resumers) {
        resume(person);
      }
    }
  }
  const store = storage();
  if (store === undefined) {
    return;
  }
  for (const key of keysOf(store)) {
    const owner = ownerOf(key);
    quietly(() => {
      if (
        owner === undefined ||
        person === undefined ||
        owner.person !== person
      ) {
        store.removeItem(key);
      } else {
        put(store, key, read(store, key, now));
      }
    });
  }
};

/**
 * Hands over `person`'s drafts of `app`, as the frame's client reads
 * them: by key, as text. Every other person's drafts in the tab go first.
 */
export const draftsFor = (
  person: string,
  app: string,
  now = Date.now()
): Record<string, string> => {
  const store = storage();
  if (store === undefined || stopped) {
    return {};
  }
  sweepDrafts(person, now);
  let kept: Drafts = new Map();
  quietly(() => {
    kept = read(store, keyOf(person, app), now);
  });
  // Handed over in one message: the newest first, as many as fit it. The
  // rest stay kept, for a screen that asks again once they are fewer.
  const handed: [string, string][] = [];
  let size = handedOverOverhead;
  for (const [name, draft] of [...kept].toSorted((a, b) => b[1].at - a[1].at)) {
    const entry =
      JSON.stringify(name).length + JSON.stringify(draft.text).length + 2;
    if (size + entry <= screenLimits.rpc.maxMessageSize) {
      handed.push([name, draft.text]);
      size += entry;
    }
  }
  return Object.fromEntries(handed);
};

/**
 * Keeps `text` as `person`'s draft `name` of `app`, or drops it (`null`).
 * A name or text past the limits, or not text at all, is dropped, never
 * kept: a frame sent it. Nothing is kept once the session ended.
 */
export const saveDraft = (
  person: string,
  app: string,
  name: unknown,
  text: unknown,
  now = Date.now()
): void => {
  const store = storage();
  if (
    store === undefined ||
    stopped ||
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > screenLimits.drafts.keyCharacters
  ) {
    return;
  }
  quietly(() => {
    const key = keyOf(person, app);
    const drafts = read(store, key, now);
    drafts.delete(name);
    if (
      typeof text === "string" &&
      text.length <= screenLimits.drafts.characters
    ) {
      drafts.set(name, { text, at: now });
    }
    write(store, key, drafts, now);
  });
};

/** The names of every draft of `app` the tab keeps, anyone's. */
const namesOf = (app: string, now = Date.now()): Set<string> => {
  const names = new Set<string>();
  const store = storage();
  if (store === undefined) {
    return names;
  }
  for (const key of keysOf(store)) {
    if (ownerOf(key)?.app === app) {
      quietly(() => {
        for (const name of read(store, key, now).keys()) {
          names.add(name);
        }
      });
    }
  }
  return names;
};

/**
 * Keeps each of `changes` as `person`'s draft of `app` by its name, or
 * drops it (`null`), as `saveDraft` does, the App's entry read and
 * written once for all of them.
 */
export const saveDrafts = (
  person: string,
  app: string,
  changes: ReadonlyMap<string, string | null>,
  now = Date.now()
): void => {
  const store = storage();
  if (store === undefined || stopped || changes.size === 0) {
    return;
  }
  quietly(() => {
    const key = keyOf(person, app);
    const drafts = read(store, key, now);
    for (const [name, text] of changes) {
      if (
        name.length === 0 ||
        name.length > screenLimits.drafts.keyCharacters
      ) {
        continue;
      }
      drafts.delete(name);
      if (text !== null && text.length <= screenLimits.drafts.characters) {
        drafts.set(name, { text, at: now });
      }
    }
    write(store, key, drafts, now);
  });
};

/**
 * Drops drafts of `app` (every person's: the page may no longer know
 * whose), or every draft in the tab when no App is named.
 */
export const clearDrafts = (app?: string): void => {
  const store = storage();
  if (store === undefined) {
    return;
  }
  for (const key of keysOf(store)) {
    if (app === undefined || ownerOf(key)?.app === app) {
      quietly(() => {
        store.removeItem(key);
      });
    }
  }
};

/**
 * Core refused the person or the App (a screen of it refused to open,
 * say): every running screen's drafts of it shut, writing nothing more,
 * and the App's drafts go.
 */
export const shutAppDrafts = (app: string): void => {
  // Each leaves the set as it shuts, which iteration allows.
  for (const shut of shutters.get(app) ?? []) {
    shut();
  }
  clearDrafts(app);
};

/**
 * The person's session ended (signed out, expired, revoked, someone else
 * signed in): no draft is written from now on, by a frame's timer or a
 * keystroke before the page reloads, and every draft goes.
 */
export const stopDrafts = (): void => {
  stopped = true;
  ended = true;
  clearDrafts();
};

/**
 * Signs out through `signOut`. No draft is written while it is on its way
 * (a frame's timer, a keystroke), and every draft goes once it succeeds,
 * as `stopDrafts` does. One that failed (offline, or refused) may leave
 * the person signed in, and the page doesn't reload: their drafts were
 * never touched, and are kept again once core says they are still signed
 * in (`sweepDrafts`), rather than silently never; unless their session
 * ended meanwhile all the same.
 */
export const stopDraftsFor = async (
  signOut: () => Promise<void>
): Promise<void> => {
  stopped = true;
  signingOut += 1;
  try {
    await signOut();
  } catch (error) {
    signingOut -= 1;
    if (!ended && signingOut === 0) {
      unconfirmed = true;
    }
    throw error;
  }
  signingOut -= 1;
  stopDrafts();
};

/** A refusal's code, as core sends it, if it has one. */
const codeOf = (error: unknown): string | undefined => {
  const code: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;
  return typeof code === "string" ? code : undefined;
};

/** Refusals of the person or the App: what was read under that access is theirs no more. */
const accessCodes: ReadonlySet<string> = new Set([
  "role.forbidden",
  "app.not_found",
  "app.unreadable",
  "permission.person_inactive",
]);

/** Whether `error` is core refusing the person or the App. */
export const lostAccess = (error: unknown): boolean => {
  const code = codeOf(error);
  return (
    code !== undefined && (accessCodes.has(code) || code.startsWith("auth."))
  );
};

/**
 * How long a frame's draft changes are gathered into one write of the
 * tab's storage. The frame sends every change as it happens, so what the
 * page holds is written, at the latest, when the page itself goes away
 * (`AppDrafts.flush`): never left to a message the frame sends as a tab
 * unloads, which the page may no longer hear.
 */
export const draftGatherMs = 300;

/** One running screen's drafts of its App, as its bridge reaches them. */
export interface AppDrafts {
  readonly drafts: () => Promise<Record<string, string>>;
  /** Gathers a change: written within `draftGatherMs`, or at `flush`. */
  readonly save: (name: unknown, text: unknown) => void;
  /** Gathers a clear of the App's drafts, as `save` does. */
  readonly clear: () => void;
  /**
   * Sees a refusal core sent the screen: one of the person or the App
   * drops the App's drafts, and no more are handed over or kept for this
   * screen, whatever its frame does.
   */
  readonly refused: (error: unknown) => void;
  /**
   * The screen is stopped for access (core no longer hands its build the
   * data, or the session is someone else's): the App's drafts go, and a
   * save still waiting to know who is signed in keeps nothing.
   */
  readonly close: () => void;
  /**
   * Writes what is gathered now, if who is signed in is known already:
   * the page or the screen is going away.
   */
  readonly flush: () => void;
  /**
   * The screen stopped: what is gathered is written as `flush` writes it,
   * and nothing more is kept for it.
   */
  readonly stop: () => void;
}

/**
 * The drafts of `app` for one running screen, for the person `whoami`
 * says is signed in: asked once it is needed, and again after a failure.
 *
 * What the frame sends is gathered, the newest change of each draft only,
 * and written once per `draftGatherMs`: the frame can't make the page do
 * more storage work than that, however fast it sends, and what waits to
 * be written is bounded by an App's count of drafts, even while core
 * can't say who is signed in. Past that count the oldest change waiting
 * goes, as the oldest draft would in storage. A clear drops what waits
 * and the App's drafts at the next write; whatever arrives after it is
 * written after it.
 */
export const appDrafts = (
  app: string,
  whoami: () => Promise<string>
): AppDrafts => {
  let person: Promise<string> | undefined;
  /** Who is signed in, once `whoami` answered. */
  let known: string | undefined;
  let closed = false;
  /** The screen stopped: it sends nothing more, but what it sent is written. */
  let retired = false;
  let clearing = false;
  const waiting = new Map<string, string | null>();
  let round: Promise<void> | undefined;
  /** Who core said is signed in after a failed sign-out, if it did (`resume`). */
  let confirmed: string | undefined;
  const personOf = async (): Promise<string> => {
    const asked = person ?? whoami();
    person = asked;
    try {
      const who = await asked;
      // Someone else than core confirmed: this screen was the person
      // before's, and writes nothing more.
      if (confirmed !== undefined && who !== confirmed) {
        closed = true;
        waiting.clear();
        throw new Error("The screen was someone else's.");
      }
      known = who;
      return known;
    } catch (error) {
      // Asked again next time, not given up on for the screen's life.
      person = undefined;
      throw error;
    }
  };
  /**
   * The names of the App's drafts the tab keeps, anyone's: read once per
   * gathering round, however many drops the frame sends.
   */
  let keptCache: { names: ReadonlySet<string>; at: number } | undefined;
  const keptNames = (): ReadonlySet<string> => {
    // Read again once anything touched the tab's drafts, another screen's
    // writes too.
    if (keptCache?.at !== storageSteps) {
      const names = namesOf(app);
      keptCache = { names, at: storageSteps };
    }
    return keptCache.names;
  };
  /** Drops the App's drafts, if a clear waits for it. */
  const clearIfAsked = (): void => {
    // Held back, as writes are, while a sign-out is on its way.
    if (clearing && !closed && !stopped) {
      keptCache = undefined;
      clearing = false;
      clearDrafts(app);
    }
  };
  /**
   * Writes what waits, as `who`'s, unless the screen was closed meanwhile.
   * While a sign-out is on its way nothing is written, and what waits
   * stays, for the next write should the person still be signed in.
   */
  const writeAs = (who: string): void => {
    keptCache = undefined;
    clearIfAsked();
    if (stopped && !closed) {
      return;
    }
    if (!closed) {
      saveDrafts(who, app, waiting);
    }
    waiting.clear();
  };
  /**
   * Writes what waits once the gathering ends, and whatever arrives
   * meanwhile. A failure to learn who is signed in loses what waits, as a
   * write the storage refused: the frame's next change asks again.
   */
  const writeGathered = async (): Promise<void> => {
    const gathering = Promise.withResolvers<null>();
    setTimeout(() => {
      gathering.resolve(null);
    }, draftGatherMs);
    await gathering.promise;
    try {
      clearIfAsked();
      while (waiting.size > 0) {
        if (closed || stopped) {
          break;
        }
        // oxlint-disable-next-line no-await-in-loop -- asked once, then known
        writeAs(await personOf());
      }
      if (closed) {
        waiting.clear();
      }
    } catch {
      waiting.clear();
    } finally {
      // In the same turn as the last look at what waits: a change that
      // arrives next starts a round of its own.
      round = undefined;
    }
  };
  /** One round of gathering at a time, each started by the change that finds none. */
  const gather = (): void => {
    round ??= writeGathered();
  };
  /** Writes what a sign-out held back, once it failed. */
  const resume = (signedIn: string): void => {
    confirmed = signedIn;
    // Someone else is signed in now: what waits was the person before's,
    // and goes, nothing written; the screen keeps no more.
    if (known !== undefined && known !== signedIn) {
      closed = true;
      waiting.clear();
      clearing = false;
      resumers.delete(resume);
      // oxlint-disable-next-line no-use-before-define -- registered just below
      others.delete(shut);
      return;
    }
    if (!retired) {
      if (waiting.size > 0 || clearing) {
        gather();
      }
      return;
    }
    clearIfAsked();
    if (known !== undefined) {
      writeAs(known);
    }
    // oxlint-disable-next-line no-use-before-define -- registered just below
    others.delete(shut);
    resumers.delete(resume);
    waiting.clear();
    clearing = false;
  };
  resumers.add(resume);
  const others = shutters.get(app) ?? new Set<() => void>();
  shutters.set(app, others);
  const shut = (): void => {
    others.delete(shut);
    resumers.delete(resume);
    closed = true;
    clearing = false;
    waiting.clear();
    clearDrafts(app);
  };
  others.add(shut);
  return {
    // Whether core refused the person or the App is looked at again once
    // who is signed in is known, just before the storage is touched: a
    // refusal that came while core was asked always wins.
    drafts: async () => {
      if (closed || retired) {
        return {};
      }
      const who = await personOf();
      // Stopped or shut meanwhile: storage is left as it is.
      if (closed || retired) {
        return {};
      }
      writeAs(who);
      return draftsFor(who, app);
    },
    save: (name, text) => {
      if (
        closed ||
        retired ||
        typeof name !== "string" ||
        name.length === 0 ||
        name.length > screenLimits.drafts.keyCharacters
      ) {
        return;
      }
      // Anything but text within the limits drops the draft (`saveDraft`).
      const change =
        typeof text === "string" &&
        text.length <= screenLimits.drafts.characters
          ? text
          : null;
      // A drop of a draft not kept has nothing to drop: what waits of it
      // goes, and no drop waits, so the drops that wait are bounded by the
      // drafts kept.
      if (change === null && !keptNames().has(name)) {
        waiting.delete(name);
        return;
      }
      waiting.delete(name);
      waiting.set(name, change);
      // Past an App's count of drafts to keep, the oldest waiting to be
      // kept goes, as it would in storage; one kept already is dropped
      // instead, so an older version of it never comes back.
      const keeps = [...waiting].filter(([, value]) => value !== null);
      const [oldest] = keeps;
      if (keeps.length > screenLimits.drafts.perApp && oldest !== undefined) {
        if (keptNames().has(oldest[0])) {
          waiting.set(oldest[0], null);
        } else {
          waiting.delete(oldest[0]);
        }
      }
      gather();
    },
    clear: () => {
      if (closed || retired) {
        return;
      }
      waiting.clear();
      clearing = true;
      gather();
    },
    refused: (error) => {
      if (lostAccess(error)) {
        // Every screen of the App shuts: none writes what it holds back.
        // Each leaves the set as it shuts, which iteration allows.
        for (const other of others) {
          other();
        }
        shut();
      }
    },
    close: shut,
    flush: () => {
      clearIfAsked();
      if (known !== undefined) {
        writeAs(known);
      }
    },
    stop: () => {
      clearIfAsked();
      if (known !== undefined) {
        writeAs(known);
      }
      retired = true;
      // Held back by a sign-out on its way: written should it fail, and
      // shut, as any screen's, should core refuse the App meanwhile.
      const heldBack =
        stopped &&
        !ended &&
        known !== undefined &&
        (waiting.size > 0 || clearing);
      if (!heldBack) {
        others.delete(shut);
        resumers.delete(resume);
        waiting.clear();
        clearing = false;
      }
    },
  };
};
