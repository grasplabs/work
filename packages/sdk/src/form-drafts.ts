import { screenLimits } from "@grasp-os/shared/screen-limits";

import { isPlainObject, valueLimits } from "./value-descriptor.ts";

// The session client's unsaved record-form drafts (GRA-254): what a person
// typed and hasn't saved, kept outside the App's own modules so it outlives
// the form that holds it. A draft survives the editor unmounting (another
// note opened, the screen navigated), a newer record arriving, a refused
// save (`data.conflict`) and, through the page, a refresh of the tab.
//
// The frame has an opaque origin and no storage of its own, so the page
// keeps the drafts for it (apps/web's form-drafts.ts), per person and App,
// in the tab's session storage; the frame gets its App's drafts when it
// starts and writes each change back. Failure modes, and how each is
// closed:
//
// - A draft reaches another person or App on a shared device: the page
//   keys every draft by the signed-in person and the one App the frame's
//   bridge is bound to; a session that ends drops them all, and whenever
//   the page learns who is signed in it deletes every draft not theirs.
//   The tab's storage is not relied on to end with the tab: a browser may
//   restore it after a crash or with the session, and that sweep is what
//   guards a restored tab.
// - A draft outlives the access it was typed under: the client clears
//   every draft at a fence (a refusal of the person or the build, or
//   someone else signing in), and the page clears an App's when it
//   refuses to open it.
// - A draft is restored against a record the person can no longer read:
//   it is restored only into an editor mounted with that record, which
//   the App's own query just supplied under the person's access; the save
//   carries the draft's old revision, which the host checks again.
// - A schema changed: a draft made under another contract of the save, or
//   by a form of other fields, is never restored, its kept arguments
//   perhaps no longer the save's; a field whose kind changed starts from
//   the record.
// - An edit is lost on a refresh because JSON drops what has no value: a
//   draft's fields are written as entries, a field without a value as
//   its name alone (`writeDraft`), and read back the same.
// - A form that isn't the one on screen writes the draft: only the form
//   that holds a key's claim writes it, taken when it mounts and let go
//   when it unmounts, and every claim goes with `clear` (`#claims`).
// - Drafts grow without bound: each is held to `screenLimits.drafts`'
//   size (a larger one stays in the frame's memory only), the oldest go
//   past the count, a day-old one is dropped unread. Every change is sent
//   to the page as it happens, which gathers them into its writes, so a
//   refresh never depends on a message sent as the tab unloads.

/** One unsaved record-form draft, as the page keeps it. */
export interface FormDraft {
  /** The exact save contract it was made under. */
  readonly fingerprint: string;
  /** The record's identity and the revision the draft started from. */
  readonly id: unknown;
  readonly rev: number;
  /** The rest of the save's arguments, as `args` mapped the baseline. */
  readonly rest: unknown;
  /** The editable fields as the baseline held them. */
  readonly base: Readonly<Record<string, unknown>>;
  /** The editable fields as the person left them. */
  readonly values: Readonly<Record<string, unknown>>;
  /** Whether a save of it was refused as stale. */
  readonly conflict: boolean;
  /** When it last changed, in Unix milliseconds. */
  readonly at: number;
}

/**
 * Where the client keeps drafts beyond its own memory: the page, over the
 * frame's bridge. Writes are best effort; a draft that can't be written
 * stays in memory for as long as the frame runs, and one that throws
 * never stops the client (`DraftStore`).
 */
export interface DraftPersistence {
  /** The App's drafts the page kept for this person, by key, as text. */
  readonly initial: Readonly<Record<string, string>>;
  /** Keeps `text` as the draft `key`, or drops it (`null`). */
  readonly write: (key: string, text: string | null) => void;
  /** Drops every draft of this person and App. */
  readonly clear: () => void;
}

/**
 * A draft's fields as its text holds them: one entry per field, in order,
 * `[name, value]`, or `[name]` for a field without a value (`undefined`),
 * which JSON would otherwise drop. Filling an absent field, or clearing
 * one, survives a refresh as any other edit does.
 */
type FieldEntries = ([string] | [string, unknown])[];

/**
 * What stands for a value left out (`undefined`) inside a field's value,
 * such as an array's item, which JSON would write as `null`. A key of the
 * value's own that starts with the marker's key gets one more of it, so
 * none is ever read back as the marker.
 */
const leftOutKey = "\u0000";

/** `value` as JSON keeps it, a value left out anywhere in it kept too. */
const encoded = (value: unknown): unknown => {
  if (value === undefined) {
    return { [leftOutKey]: 0 };
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => encoded(item));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key.startsWith(leftOutKey) ? `${leftOutKey}${key}` : key,
        encoded(entry),
      ])
    );
  }
  return value;
};

/**
 * `value` read back as `encoded` wrote it. Nested deeper than a value may
 * be (`valueLimits.depth`), it is no draft of ours, and it throws.
 */
const decoded = (value: unknown, depth = 0): unknown => {
  if (depth > valueLimits.depth) {
    throw new Error("A draft nested past what a value may be.");
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => decoded(item, depth + 1));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === leftOutKey) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key.startsWith(leftOutKey) ? key.slice(leftOutKey.length) : key,
      decoded(entry, depth + 1),
    ])
  );
};

/** `fields` as entries (`FieldEntries`). */
const entriesOf = (fields: Readonly<Record<string, unknown>>): FieldEntries =>
  Object.entries(fields).map(([name, value]) =>
    value === undefined ? [name] : [name, encoded(value)]
  );

/** Fields read back from their entries, or undefined for anything else. */
const fieldsOf = (
  entries: unknown
): Readonly<Record<string, unknown>> | undefined => {
  if (!Array.isArray(entries)) {
    return undefined;
  }
  const fields = new Map<string, unknown>();
  for (const entry of entries) {
    if (
      !Array.isArray(entry) ||
      typeof entry[0] !== "string" ||
      (entry.length !== 1 && entry.length !== 2)
    ) {
      return undefined;
    }
    fields.set(entry[0], entry.length === 2 ? decoded(entry[1]) : undefined);
  }
  return Object.fromEntries(fields);
};

/** A draft as its text: what `readDraft` reads back, every field kept. */
export const writeDraft = (draft: FormDraft): string =>
  JSON.stringify({
    ...draft,
    rest: encoded(draft.rest),
    base: entriesOf(draft.base),
    values: entriesOf(draft.values),
  });

/** A draft read back from its text (`writeDraft`), or undefined for anything else. */
export const readDraft = (text: string, now: number): FormDraft | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) {
    return undefined;
  }
  const { fingerprint, id, rev, rest, base, values, conflict, at } = parsed;
  let baseValues: Readonly<Record<string, unknown>> | undefined;
  let draftValues: Readonly<Record<string, unknown>> | undefined;
  let restValue: unknown;
  try {
    baseValues = fieldsOf(base);
    draftValues = fieldsOf(values);
    restValue = decoded(rest);
  } catch {
    // Nested past any value: dropped unread, as one too old is.
    return undefined;
  }
  if (
    typeof fingerprint !== "string" ||
    id === undefined ||
    typeof rev !== "number" ||
    rest === undefined ||
    baseValues === undefined ||
    draftValues === undefined ||
    typeof conflict !== "boolean" ||
    typeof at !== "number" ||
    now - at > screenLimits.drafts.maxAgeMs
  ) {
    return undefined;
  }
  return {
    fingerprint,
    id,
    rev,
    rest: restValue,
    base: baseValues,
    values: draftValues,
    conflict,
    at,
  };
};

/**
 * The App a draft's key names (form.ts names it first: `record:` and the
 * JSON of the App, the save's path and the record), or "" for another.
 */
const appOf = (key: string): string => {
  const prefix = "record:";
  if (!key.startsWith(prefix)) {
    return "";
  }
  try {
    const named: unknown = JSON.parse(key.slice(prefix.length));
    return Array.isArray(named) && typeof named[0] === "string" ? named[0] : "";
  } catch {
    return "";
  }
};

/** Whether `text` fits one draft once JSON escapes it again on the port. */
const fits = (text: string): boolean =>
  JSON.stringify(text).length <= screenLimits.drafts.characters;

/**
 * A session client's drafts, by key: in memory for the frame's life, and
 * written through to `persistence`, when there is one.
 */
export class DraftStore {
  readonly #drafts = new Map<string, FormDraft>();
  readonly #persistence: DraftPersistence | undefined;
  /**
   * The one form that writes each key's draft (`claim`): every draft write
   * of a form goes through `putFor` or `dropFor`, which hold only for the
   * key's claimant. A form claims its key when it mounts and lets go when
   * it unmounts, and every claim goes with `clear` (a fence, someone else
   * signing in). So a form never writes a draft once it closed, once a
   * newer editor of the record opened, or once access ended: a late answer
   * to its save touches nothing.
   */
  readonly #claims = new Map<string, object>();
  #epoch = 0;

  constructor(persistence?: DraftPersistence, now = Date.now()) {
    this.#persistence = persistence;
    for (const [key, text] of Object.entries(persistence?.initial ?? {})) {
      const draft = typeof text === "string" ? readDraft(text, now) : undefined;
      if (
        draft !== undefined &&
        key.length <= screenLimits.drafts.keyCharacters
      ) {
        this.#drafts.set(key, draft);
      }
    }
  }

  /**
   * The draft `key`, if one is kept and not yet a day old. Only reads: a
   * form restores from it while it renders. An older one is overwritten
   * by the next edit, and the page never hands it over again.
   */
  get(key: string, now = Date.now()): FormDraft | undefined {
    const draft = this.#drafts.get(key);
    return draft !== undefined && now - draft.at <= screenLimits.drafts.maxAgeMs
      ? draft
      : undefined;
  }

  /**
   * Keeps `draft` as `key`, the oldest of its App's going past the count:
   * a portable client edits several Apps' records, and one App's drafts
   * never cost another's.
   */
  put(key: string, draft: FormDraft): void {
    this.#drafts.delete(key);
    this.#drafts.set(key, draft);
    const app = appOf(key);
    const apps = [...this.#drafts].filter(([other]) => appOf(other) === app);
    if (apps.length > screenLimits.drafts.perApp) {
      // The one written longest ago, whatever order they were kept in (a
      // page hands its drafts over newest first).
      let [oldest] = apps;
      for (const entry of apps) {
        if (oldest === undefined || entry[1].at < oldest[1].at) {
          oldest = entry;
        }
      }
      if (oldest !== undefined) {
        this.drop(oldest[0]);
      }
    }
    this.#write(key);
  }

  /** Drops the draft `key`. */
  drop(key: string): void {
    if (this.#drafts.delete(key)) {
      this.#write(key);
    }
  }

  /** Makes `owner` the one form that writes `key`'s draft (see `#claims`). */
  /**
   * How many times every draft was cleared (`clear`): a form made before
   * the last never claims a key again (`claim`'s `epoch`).
   */
  get epoch(): number {
    return this.#epoch;
  }

  claim(key: string, owner: object, epoch = this.#epoch): boolean {
    // Made before a clear (a fence, someone else signing in): its values
    // were read under access that ended, and it never writes them.
    if (epoch !== this.#epoch) {
      return false;
    }
    this.#claims.set(key, owner);
    return true;
  }

  /** `owner` lets go of `key`, if it holds it still. */
  release(key: string, owner: object): void {
    if (this.#claims.get(key) === owner) {
      this.#claims.delete(key);
    }
  }

  /** Keeps `draft` as `key` for `owner`, only while it holds the key's claim. */
  putFor(key: string, owner: object, draft: FormDraft): void {
    if (this.#claims.get(key) === owner) {
      this.put(key, draft);
    }
  }

  /** Drops the draft `key` for `owner`, only while it holds the key's claim. */
  dropFor(key: string, owner: object): void {
    if (this.#claims.get(key) === owner) {
      this.drop(key);
    }
  }

  /**
   * Drops the draft `key` if it is still `draft` and no editor holds the
   * key: a save of it that committed after its editor closed leaves no
   * draft of what is saved, while a newer edit, or an editor open, keeps
   * theirs.
   */
  dropSaved(key: string, draft: FormDraft): void {
    if (!this.#claims.has(key) && this.#drafts.get(key) === draft) {
      this.drop(key);
    }
  }

  /**
   * Drops every draft, here and where they are kept: access was lost.
   * What is in memory goes first, and whatever the page does, the clear
   * goes on: a fence never stops at the drafts.
   */
  clear(): void {
    this.#epoch += 1;
    this.#drafts.clear();
    this.#claims.clear();
    try {
      this.#persistence?.clear();
    } catch {
      // Best effort: the page drops them too when it refuses the screen.
    }
  }

  /**
   * Writes the draft `key` as it is now. Best effort: a draft that can't
   * be serialized or written stays in memory, and the next is written.
   */
  #write(key: string): void {
    if (key.length > screenLimits.drafts.keyCharacters) {
      return;
    }
    const draft = this.#drafts.get(key);
    let text: string | null = null;
    try {
      text = draft === undefined ? null : writeDraft(draft);
    } catch {
      // Can't be written as text: kept in memory only, as a draft too
      // large is.
    }
    try {
      // Kept in memory only: whatever an earlier version left in the page
      // goes, so a refresh never restores an old one.
      this.#persistence?.write(key, text !== null && fits(text) ? text : null);
    } catch {
      // Kept in memory for as long as the frame runs.
    }
  }
}
