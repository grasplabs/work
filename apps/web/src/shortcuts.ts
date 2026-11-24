// The frame's keyboard shortcuts: ⌘ and a letter on a Mac, Ctrl and the
// letter elsewhere (⌘K for the chats window, ⌘J for Grasp's chat).

const applePlatform = /mac|iphone|ipad/iu;

/** `key` as the shortcut reads here: ⌘K on a Mac, Ctrl K elsewhere. */
export const shortcutLabel = (key: string): string =>
  typeof navigator !== "undefined" && applePlatform.test(navigator.userAgent)
    ? `⌘${key.toUpperCase()}`
    : `Ctrl ${key.toUpperCase()}`;

/** Whether `event` is the shortcut for `key`, with nothing else held. */
export const isShortcut = (event: KeyboardEvent, key: string): boolean =>
  (event.metaKey || event.ctrlKey) &&
  !event.altKey &&
  !event.shiftKey &&
  event.key.toLowerCase() === key;
