// What Terminal shows of a program's output (terminal.tsx): the text, cut into runs that each carry
// one look. A pure reader of ANSI SGR ("Select Graphic Rendition") sequences: the 16 colours of the
// foreground (30–37, 90–97) and the background (40–47, 100–107), the 256-colour and truecolour forms
// (38;5;n, 38;2;r;g;b and their colon forms), each brought to the nearest of the 16, and bold, dim,
// italic, underline and reset. Every other escape sequence (moving the cursor, clearing the screen,
// setting the title, an OSC 8 hyperlink) and every other control character is taken out, never
// drawn and never acted on; a hyperlink's words stay as words. A carriage return starts its line
// again, as a progress bar redraws itself. One pass over the text, so a hostile one costs no more
// than a long one. Tested without a page (scripts/terminal-ansi.test.ts).

/** One of the 16 terminal colours, by its SGR name. */
export type AnsiColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

/** A run's look: its colours by name, null for the terminal's own, and its weight and marks. */
export interface AnsiStyle {
  fg: AnsiColor | null;
  bg: AnsiColor | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

/** A run of text in one look. `key` names the look, the same for every run that looks the same. */
export interface AnsiSpan {
  text: string;
  style: AnsiStyle;
  key: string;
}

const COLORS: readonly AnsiColor[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

// xterm's 16 colours, only to find which of them a 256-colour or truecolour value is nearest to.
const PALETTE: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

// The six levels of each channel in the 256-colour cube.
const CUBE = [0, 95, 135, 175, 215, 255];

/** A sequence longer than this is not one a program writes: it is taken out, unread. */
const MOST_SEQUENCE = 256;
/** The longest string sequence's body read (an OSC 8 link's address is the longest a program writes). */
const MOST_STRING = 4096;
/** At most this many numbers of one SGR sequence are read. */
const MOST_PARAMS = 32;

const ESC = 0x1b;
const BEL = 0x07;
const LF = 0x0a;
const CR = 0x0d;
const TAB = 0x09;
// C1 controls, the one-character forms of ESC [ (CSI), ESC ] (OSC), ESC P (DCS), ESC X (SOS),
// ESC ^ (PM), ESC _ (APC) and ESC \ (ST).
const C1_CSI = 0x9b;
const C1_OSC = 0x9d;
const C1_STRINGS = new Set([0x90, 0x98, 0x9e, 0x9f]);
const C1_ST = 0x9c;
// What follows ESC to open a string sequence: ] P X ^ _.
const STRING_OPENERS = new Set([0x5d, 0x50, 0x58, 0x5e, 0x5f]);

const plain: AnsiStyle = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
};

/** The character code at `at`, or -1 past the end. */
const codeAt = (text: string, at: number): number => text.codePointAt(at) ?? -1;

const keyOf = (style: AnsiStyle): string =>
  [
    style.fg === null ? "" : `fg-${style.fg}`,
    style.bg === null ? "" : `bg-${style.bg}`,
    style.bold ? "bold" : "",
    style.dim ? "dim" : "",
    style.italic ? "italic" : "",
    style.underline ? "underline" : "",
  ]
    .filter(Boolean)
    .join(" ");

const clampByte = (value: number) =>
  Number.isFinite(value) ? Math.min(255, Math.max(0, Math.trunc(value))) : 0;

/** The one of the 16 colours nearest to a red, green and blue. */
const nearest = (red: number, green: number, blue: number): AnsiColor => {
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (const [index, [r, g, b]] of PALETTE.entries()) {
    const d = (r - red) ** 2 + (g - green) ** 2 + (b - blue) ** 2;
    if (d < distance) {
      distance = d;
      best = index;
    }
  }
  return COLORS[best] ?? "white";
};

/** A 256-colour index as one of the 16: the first 16 as they are, the cube and the greys nearest. */
const fromIndex = (index: number): AnsiColor => {
  const at = clampByte(index);
  if (at < 16) {
    return COLORS[at] ?? "white";
  }
  if (at >= 232) {
    const grey = 8 + (at - 232) * 10;
    return nearest(grey, grey, grey);
  }
  const cube = at - 16;
  return nearest(
    CUBE[Math.floor(cube / 36)] ?? 0,
    CUBE[Math.floor(cube / 6) % 6] ?? 0,
    CUBE[cube % 6] ?? 0
  );
};

/**
 * An extended colour (after 38 or 48) from the numbers at `from`: `5;n`, or `2;r;g;b`. The colour,
 * or null when it cannot be read, and how many numbers it used.
 */
const extended = (
  params: readonly number[],
  from: number
): { color: AnsiColor | null; used: number } => {
  const mode = params[from];
  if (mode === 5) {
    const index = params[from + 1];
    return { color: index === undefined ? null : fromIndex(index), used: 2 };
  }
  if (mode === 2) {
    const red = params[from + 1];
    const green = params[from + 2];
    const blue = params[from + 3];
    if (red === undefined || green === undefined || blue === undefined) {
      return { color: null, used: 4 };
    }
    return {
      color: nearest(clampByte(red), clampByte(green), clampByte(blue)),
      used: 4,
    };
  }
  return { color: null, used: 1 };
};

/** A parameter's number: its digits, or 0 when it has none. */
const numberOf = (part: string) => {
  const value = Math.trunc(Number(part));
  return Number.isNaN(value) ? 0 : value;
};

/** A colon group's numbers (`38:2::r:g:b`, `4:3`) in the semicolon form. */
const colonGroup = (group: string): number[] => {
  const parts = group.split(":").slice(0, MOST_PARAMS).map(numberOf);
  const [head, mode] = parts;
  if ((head === 38 || head === 48) && mode === 2 && parts.length >= 6) {
    // 38:2:<colour space>:r:g:b
    return [head, 2, ...parts.slice(3, 6)];
  }
  if (head === 4) {
    // 4:0 is no underline; 4:1 to 4:5 are kinds of underline.
    return [mode === 0 ? 24 : 4];
  }
  return parts;
};

/** The numbers of an SGR sequence's parameter text; none at all is a reset. */
const paramsOf = (text: string): number[] => {
  if (text === "") {
    return [0];
  }
  return text
    .split(";")
    .slice(0, MOST_PARAMS)
    .flatMap((group) =>
      group.includes(":") ? colonGroup(group) : [numberOf(group)]
    );
};

/** What each plain SGR code sets: the marks on and off, and the reset. */
const MARKS: ReadonlyMap<number, Partial<AnsiStyle>> = new Map<
  number,
  Partial<AnsiStyle>
>([
  [0, plain],
  [1, { bold: true }],
  [2, { dim: true }],
  [3, { italic: true }],
  [4, { underline: true }],
  [21, { underline: true }],
  [22, { bold: false, dim: false }],
  [23, { italic: false }],
  [24, { underline: false }],
  [39, { fg: null }],
  [49, { bg: null }],
]);

/** The colour a 16-colour code sets, as text or as ground, or null when it is not one. */
const basicColor = (
  code: number
): { fg: AnsiColor | null } | { bg: AnsiColor | null } | null => {
  if (code >= 30 && code <= 37) {
    return { fg: COLORS[code - 30] ?? null };
  }
  if (code >= 90 && code <= 97) {
    return { fg: COLORS[code - 90 + 8] ?? null };
  }
  if (code >= 40 && code <= 47) {
    return { bg: COLORS[code - 40] ?? null };
  }
  if (code >= 100 && code <= 107) {
    return { bg: COLORS[code - 100 + 8] ?? null };
  }
  return null;
};

/** The look after an SGR sequence's numbers, from the look before it. */
const applySgr = (before: AnsiStyle, params: readonly number[]): AnsiStyle => {
  const style = { ...before };
  let at = 0;
  while (at < params.length) {
    const code = params[at] ?? 0;
    at += 1;
    if (code === 38 || code === 48) {
      const { color, used } = extended(params, at);
      at += used;
      if (color !== null) {
        Object.assign(style, code === 38 ? { fg: color } : { bg: color });
      }
    } else {
      // Any other code (blink, inverse, hidden, strike, fonts) changes nothing.
      Object.assign(style, MARKS.get(code), basicColor(code));
    }
  }
  return style;
};

/**
 * Where a string sequence (OSC, DCS, SOS, PM, APC) whose body starts at `from` ends: past BEL or
 * ST, or at the next escape. One never ended takes only the rest of its line, and at most
 * MOST_STRING characters: what follows is output again, never hidden behind a sequence a program
 * broke off.
 */
const endOfString = (input: string, from: number): number => {
  const last = Math.min(input.length, from + MOST_STRING);
  for (let at = from; at < last; at += 1) {
    const code = codeAt(input, at);
    if (code === BEL || code === C1_ST) {
      return at + 1;
    }
    if (code === ESC) {
      // ESC \ is ST; any other escape starts a sequence of its own, as a terminal reads it.
      return codeAt(input, at + 1) === 0x5c ? at + 2 : at;
    }
    if (code === LF || code === CR) {
      return at;
    }
  }
  return last;
};

/**
 * A control sequence (CSI) whose parameters start at `from`: where it ends, and its parameter text
 * when it is SGR, or null when it is anything else, broken, or longer than any a program writes.
 */
const readCsi = (
  input: string,
  from: number
): { end: number; sgr: string | null } => {
  for (let at = from; at < input.length; at += 1) {
    const code = codeAt(input, at);
    if (code >= 0x40 && code <= 0x7e) {
      // The final byte.
      const short = at - from <= MOST_SEQUENCE;
      const params = short ? input.slice(from, at) : "";
      const sgr =
        code === 0x6d && short && /^[\d;:]*$/u.test(params) ? params : null;
      return { end: at + 1, sgr };
    }
    if (code < 0x20 || code > 0x3f) {
      // Not a parameter or an intermediate: the sequence is broken here; what follows is text.
      return { end: at, sgr: null };
    }
  }
  // Unterminated: it is taken out to the end.
  return { end: input.length, sgr: null };
};

/** Where an escape other than CSI and the strings ends: ESC, any intermediates, one final byte. */
const endOfEscape = (input: string, at: number): number => {
  let end = at + 1;
  while (
    end < input.length &&
    end - at <= MOST_SEQUENCE &&
    codeAt(input, end) >= 0x20 &&
    codeAt(input, end) <= 0x2f
  ) {
    end += 1;
  }
  const final = codeAt(input, end);
  return final >= 0x30 && final <= 0x7e ? end + 1 : end;
};

const isControl = (code: number) =>
  code !== TAB &&
  (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f));

/**
 * A program's output as runs of text, each in one look, in order. Escape sequences and control
 * characters are taken out; a newline and a tab stay in the text.
 *
 *   parseAnsi("\x1b[1;32mPASS\x1b[0m src/sum.test.ts")
 *   // [{ text: "PASS", key: "fg-green bold", … }, { text: " src/sum.test.ts", key: "", … }]
 */
export const parseAnsi = (input: string): AnsiSpan[] => {
  const spans: AnsiSpan[] = [];
  let style = plain;
  let key = "";
  let text = "";
  // Where the current line began: in which run, and how far into that run's text.
  let lineSpan = 0;
  let lineOffset = 0;
  // A carriage return waits for the next words before it clears its line, so a line being redrawn
  // shows what it last said until the new words come.
  let restart = false;

  const flush = () => {
    if (text === "") {
      return;
    }
    const last = spans.at(-1);
    if (last?.key === key) {
      last.text += text;
    } else {
      spans.push({ text, style, key });
    }
    text = "";
  };

  const restartLine = () => {
    restart = false;
    flush();
    spans.length = Math.min(spans.length, lineSpan + 1);
    const first = spans[lineSpan];
    if (first !== undefined) {
      first.text = first.text.slice(0, lineOffset);
      if (first.text === "") {
        spans.length = lineSpan;
      }
    }
  };

  const newLine = () => {
    restart = false;
    text += "\n";
    flush();
    lineSpan = spans.length - 1;
    lineOffset = spans.at(-1)?.text.length ?? 0;
  };

  let at = 0;
  let start = 0;
  // The words from `start` to here, into the current run.
  const take = () => {
    if (start < at) {
      if (restart) {
        restartLine();
      }
      text += input.slice(start, at);
    }
  };

  while (at < input.length) {
    const code = codeAt(input, at);
    if (!isControl(code)) {
      at += 1;
      continue;
    }
    take();
    const next = codeAt(input, at + 1);
    if (code === LF) {
      newLine();
      at += 1;
    } else if (code === CR && next === LF) {
      newLine();
      at += 2;
    } else if (code === CR) {
      restart = true;
      at += 1;
    } else if (code === C1_CSI || (code === ESC && next === 0x5b)) {
      const { end, sgr } = readCsi(input, at + (code === ESC ? 2 : 1));
      if (sgr !== null) {
        flush();
        style = applySgr(style, paramsOf(sgr));
        key = keyOf(style);
      }
      at = end;
    } else if (code === C1_OSC || C1_STRINGS.has(code)) {
      at = endOfString(input, at + 1);
    } else if (code === ESC && STRING_OPENERS.has(next)) {
      // OSC (a title, a hyperlink), DCS, SOS, PM or APC: up to its end, taken out.
      at = endOfString(input, at + 2);
    } else if (code === ESC) {
      at = endOfEscape(input, at);
    } else {
      // Any other control character (a bell, a backspace) is taken out.
      at += 1;
    }
    start = at;
  }
  take();
  flush();
  return spans;
};

/** A program's output as plain text: its words, without its escape sequences. */
export const plainText = (input: string): string =>
  parseAnsi(input)
    .map((span) => span.text)
    .join("");
