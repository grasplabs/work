// What StackTrace reads from an error's stack (stack-trace.tsx): its type, its message and its
// frames, from V8's form (Chrome, Node: "    at fn (file:12:5)") and from Firefox's and Safari's
// ("fn@file:12:5"). Pure and bounded: only the first MOST_CHARACTERS of a stack and its first
// MOST_FRAMES frames are read, a line is read only up to MOST_LINE characters, and every line is
// read with string searches that run once over it, so a hostile stack costs no more than a long
// one. Tested without a page (scripts/stack-trace-parse.test.ts).

/** One frame of a stack: the function, the file and where in it, as far as the line says them. */
export interface StackFrame {
  /** The frame's line as written, trimmed. */
  raw: string;
  /** The function, or null when the line names none ("<anonymous>" is a name). */
  functionName: string | null;
  /** The file or URL, or null when the line gives none. */
  filePath: string | null;
  /** The line in the file, from 1, or null. */
  lineNumber: number | null;
  /** The column in the line, from 1, or null. */
  columnNumber: number | null;
  /** From a dependency or the runtime (node_modules, node:, internal/, native code), not the product's own code. */
  isInternal: boolean;
}

/** A stack as read: the error's type and message, and its frames in order. */
export interface ParsedStackTrace {
  /** The error's type ("TypeError"), or null when the stack does not name one. */
  errorType: string | null;
  /** The error's message: everything before the first frame after the type, or "" when there is none. */
  errorMessage: string;
  /** Its frames, innermost first. */
  frames: StackFrame[];
}

/** Of a longer stack only this much is read. */
const MOST_CHARACTERS = 100_000;
/** Of more frames only this many are kept. */
const MOST_FRAMES = 200;
/** A line longer than this is not read for its parts: it is a frame only as it is written. */
const MOST_LINE = 2000;

// An error's type: a name (dotted for a namespace) that ends in Error or Exception, or is Error,
// with an optional code in brackets ("Error [ERR_ASSERTION]"); after an optional "Uncaught ".
const TYPE =
  /^(?:Uncaught )?(?<type>(?:[A-Za-z_$][\w$.]*)?(?:Error|Exception))(?: \[[\w-]+\])?$/u;
// The end of a location: ":line:column" or ":line".
const POSITION = /:(?<line>\d+)(?::(?<column>\d+))?$/u;

const isInternalPath = (path: string) =>
  path.includes("node_modules") ||
  path.startsWith("node:") ||
  path.includes("internal/") ||
  path.includes("[native code]");

/** A location ("file:12:5", "file", "native") as its file, line and column. */
const locationOf = (
  location: string
): Pick<StackFrame, "filePath" | "lineNumber" | "columnNumber"> => {
  const found = POSITION.exec(location);
  if (found === null) {
    return {
      filePath: location === "" ? null : location,
      lineNumber: null,
      columnNumber: null,
    };
  }
  const filePath = location.slice(0, found.index);
  const column = found.groups?.column;
  return {
    filePath: filePath === "" ? null : filePath,
    lineNumber: Number(found.groups?.line),
    columnNumber: column === undefined ? null : Number(column),
  };
};

const frameOf = (
  raw: string,
  functionName: string | null,
  location: string
): StackFrame => {
  const where = locationOf(location);
  return {
    raw,
    functionName: functionName === "" ? null : functionName,
    ...where,
    isInternal: isInternalPath(where.filePath ?? raw),
  };
};

/** A frame line as written, read for no parts: too long, or a form not known. */
const bareFrame = (raw: string): StackFrame => ({
  raw,
  functionName: null,
  filePath: null,
  lineNumber: null,
  columnNumber: null,
  isInternal: isInternalPath(raw),
});

/** V8's frame, after its "at ": "fn (location)", "location", or "eval at … (…), <anonymous>:1:1". */
const v8Frame = (raw: string, rest: string): StackFrame => {
  const open = rest.indexOf(" (");
  if (open === -1 || !rest.endsWith(")")) {
    return frameOf(raw, null, rest);
  }
  const location = rest.slice(open + 2, -1);
  // An eval's location names where it was evaluated, not a file to open.
  if (location.startsWith("eval at ")) {
    return {
      ...bareFrame(raw),
      functionName: rest.slice(0, open),
    };
  }
  return frameOf(raw, rest.slice(0, open), location);
};

/** One line of a stack as a frame, or null when it is not one. */
const parseFrame = (line: string): StackFrame | null => {
  const raw = line.trim();
  if (raw.startsWith("at ")) {
    return raw.length > MOST_LINE ? bareFrame(raw) : v8Frame(raw, raw.slice(3));
  }
  // Firefox and Safari: "fn@location", "@location", or Safari's bare "[native code]".
  if (raw === "[native code]") {
    return bareFrame(raw);
  }
  const at = raw.indexOf("@");
  if (at === -1 || raw.length > MOST_LINE) {
    return null;
  }
  const location = raw.slice(at + 1);
  // A message line can hold an "@" (an email); a frame's location ends in its position or is native.
  if (!POSITION.test(location) && location !== "[native code]") {
    return null;
  }
  return frameOf(raw, raw.slice(0, at), location);
};

/** The error's first line as its type and the start of its message. */
const headOf = (
  first: string
): { errorType: string | null; message: string } => {
  const colon = first.indexOf(":");
  const name = colon === -1 ? first : first.slice(0, colon);
  if (name.length <= MOST_LINE && TYPE.test(name)) {
    return {
      errorType: TYPE.exec(name)?.groups?.type ?? name,
      message: colon === -1 ? "" : first.slice(colon + 1).trim(),
    };
  }
  return { errorType: null, message: first.trim() };
};

/**
 * An error's stack, as `error.stack` or a tool's error text gives it, read into its type, message
 * and frames. Lines after the first frame that are not frames ("... 4 more") are left out.
 *
 *   parseStackTrace("TypeError: x is undefined\n    at run (src/app.ts:3:9)")
 *   // { errorType: "TypeError", errorMessage: "x is undefined",
 *   //   frames: [{ functionName: "run", filePath: "src/app.ts", lineNumber: 3, … }] }
 */
export const parseStackTrace = (trace: string): ParsedStackTrace => {
  const lines = trace.slice(0, MOST_CHARACTERS).split("\n");
  const frames: StackFrame[] = [];
  const head: string[] = [];
  for (const line of lines) {
    if (frames.length >= MOST_FRAMES) {
      break;
    }
    const frame = parseFrame(line);
    if (frame !== null) {
      frames.push(frame);
    } else if (frames.length === 0 && line.trim() !== "") {
      head.push(line.trimEnd());
    }
  }
  const [first, ...more] = head;
  if (first === undefined) {
    return { errorType: null, errorMessage: "", frames };
  }
  const { errorType, message } = headOf(first);
  return {
    errorType,
    errorMessage: [message, ...more].filter((part) => part !== "").join("\n"),
    frames,
  };
};
