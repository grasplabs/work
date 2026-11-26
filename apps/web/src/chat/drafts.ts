import { useSyncExternalStore } from "react";

import type { BoxMention } from "./mentions.tsx";

// What the person typed in a chat's box and hasn't sent, kept per chat in
// this browser for them alone (local storage, `grasp.chat.draft.<userId>.`
// and the chat's ID), as T3 Code keeps a draft per thread: back in the
// chat, or after a reload, the box holds it again, until it is sent. Before
// there is a chat, the draft of the slot's next one (`new.<slot>`): Chat's
// start and the dock share the person's own. The words and what they
// mention, never the files: a file picked for the box is the page's until
// the question carries it, and nothing is kept of it. Every box showing a
// chat reads the same draft (the chat's page and its dock alike), and
// signing out forgets them all.

/** A chat's unsent words, and what they mention (`@`). */
export interface Draft {
  text: string;
  mentions: readonly BoxMention[];
}

export const emptyDraft: Draft = { text: "", mentions: [] };

const prefix = "grasp.chat.draft.";

/** Where `userId`'s draft for `chatId` is kept; none: the next chat in `slot`. */
const keyOf = (userId: string, chatId: string | undefined, slot: string) =>
  `${prefix}${userId}.${chatId ?? `new.${slot}`}`;

const isMention = (value: unknown): value is BoxMention =>
  typeof value === "object" &&
  value !== null &&
  ["kind", "id", "label", "trigger"].every(
    (field) => typeof Reflect.get(value, field) === "string"
  );

/** A draft as kept, or none when it isn't one (or can't be read). */
const parsed = (kept: string | null): Draft => {
  let stored: unknown;
  try {
    stored = JSON.parse(kept ?? "null");
  } catch {
    return emptyDraft;
  }
  if (typeof stored !== "object" || stored === null) {
    return emptyDraft;
  }
  const text: unknown = Reflect.get(stored, "text");
  const mentions: unknown = Reflect.get(stored, "mentions");
  return typeof text === "string"
    ? {
        text,
        mentions: Array.isArray(mentions) ? mentions.filter(isMention) : [],
      }
    : emptyDraft;
};

/**
 * Each draft as last read, by key, with the text it was read from: one
 * object for as long as what is kept doesn't change, as React wants it.
 * Where storage refuses (a private window), the draft lives here alone,
 * until the page reloads.
 */
const read = new Map<string, { kept: string | null; draft: Draft }>();

const listeners = new Set<() => void>();

/** What is kept at `key`; undefined where storage refuses. */
const keptAt = (key: string): string | null | undefined => {
  try {
    return localStorage.getItem(key);
  } catch {
    return undefined;
  }
};

const draftAt = (key: string): Draft => {
  const kept = keptAt(key);
  const last = read.get(key);
  if (last !== undefined && (kept === undefined || kept === last.kept)) {
    return last.draft;
  }
  const draft = kept === undefined ? emptyDraft : parsed(kept);
  read.set(key, { kept: kept ?? null, draft });
  return draft;
};

const keep = (key: string, draft: Draft): void => {
  const kept = draft.text.trim() === "" ? null : JSON.stringify(draft);
  read.set(key, { kept, draft });
  try {
    if (kept === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, kept);
    }
  } catch {
    // Storage refused: the draft lasts until the page reloads.
  }
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

/** `userId`'s draft for `chatId`; none: for the next chat in `slot`. */
export const draftFor = (
  userId: string,
  chatId: string | undefined,
  slot: string
): Draft => draftAt(keyOf(userId, chatId, slot));

/** Keeps `draft` as `userId`'s for `chatId` (none: the next chat in `slot`). */
export const keepDraft = (
  userId: string,
  chatId: string | undefined,
  slot: string,
  draft: Draft
): void => {
  keep(keyOf(userId, chatId, slot), draft);
};

/**
 * `userId`'s draft for `chatId` (none: the next chat in `slot`), and what
 * changes it; every box on the page showing it follows.
 */
export const useDraft = (
  userId: string,
  chatId: string | undefined,
  slot: string
): [Draft, (change: (now: Draft) => Draft) => void] => {
  const draft = useSyncExternalStore(subscribe, () =>
    draftFor(userId, chatId, slot)
  );
  return [
    draft,
    (change) => {
      keepDraft(userId, chatId, slot, change(draftFor(userId, chatId, slot)));
    },
  ];
};

/**
 * Moves what is left of `userId`'s draft for the next chat in `slot` to
 * the chat a question just made there (`chatId`): words typed while it
 * was on its way stay the person's, in that chat.
 */
export const moveNewDraft = (
  userId: string,
  slot: string,
  chatId: string
): void => {
  const from = keyOf(userId, undefined, slot);
  const left = draftAt(from);
  keep(from, emptyDraft);
  if (left.text.trim() !== "") {
    keep(keyOf(userId, chatId, slot), left);
  }
};

/** Forgets every draft kept in this browser: the person signed out. */
export const forgetDrafts = (): void => {
  read.clear();
  try {
    const keys = Array.from(
      { length: localStorage.length },
      (_, index) => localStorage.key(index) ?? ""
    );
    for (const key of keys) {
      if (key.startsWith(prefix)) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Storage refused: nothing was kept.
  }
  for (const listener of listeners) {
    listener();
  }
};
