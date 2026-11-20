// The bar's global key: "mod+j", "ctrl+shift+j" or a bare key such as "/". `mod` is Meta on Apple
// platforms and Control elsewhere. A bare key is a key someone also types, so it is ignored while
// focus is somewhere that takes text: a field, a textarea, a select or anything contenteditable.

interface Keys {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  bare: boolean;
}

const isApple = () => /Mac|iPhone|iPad|iPod/u.test(navigator.userAgent);

/** The keys a shortcut names, read once when it is set. */
export const readShortcut = (shortcut: string): Keys => {
  const parts = shortcut.toLowerCase().split("+");
  // "mod++" names the plus key: the last part is empty, so the key is "+".
  const last = parts.at(-1) ?? "";
  const key = last === "" ? "+" : last;
  const names = new Set(parts.slice(0, -1));
  const mod = names.has("mod");
  const apple = isApple();
  const ctrl = names.has("ctrl") || names.has("control") || (mod && !apple);
  const meta = names.has("meta") || names.has("cmd") || (mod && apple);
  const alt = names.has("alt") || names.has("option");
  const shift = names.has("shift");
  return { key, ctrl, meta, alt, shift, bare: !ctrl && !meta && !alt };
};

/** Focus is somewhere that takes typing, where a bare key is a letter and not a shortcut. */
const typingIn = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target.closest("input, textarea, select") !== null
  );
};

/** The key pressed is the shortcut's. */
export const pressed = (event: KeyboardEvent, keys: Keys): boolean => {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.key.toLowerCase() !== keys.key
  ) {
    return false;
  }
  if (
    event.ctrlKey !== keys.ctrl ||
    event.metaKey !== keys.meta ||
    event.altKey !== keys.alt
  ) {
    return false;
  }
  // A letter's Shift is part of the shortcut; a sign's ("?" is Shift and "/") is part of the key.
  const letter = /^\p{L}$/u.test(keys.key);
  if ((letter || keys.shift) && event.shiftKey !== keys.shift) {
    return false;
  }
  return !keys.bare || !typingIn(event.target);
};
