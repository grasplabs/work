// What a stalled run is stuck in, for the stall reporter (stall-reporter.ts)
// to print before it ends the run: the thread stacks of every workerd the
// Vitest process started, their sockets and peers, and the Vitest process's
// own JavaScript stack and sockets. A stall in a Worker test leaves nothing
// in the log to say where; these show whether a workerd waits in its event
// loop (and on which peer), runs JavaScript, or is stuck in the runtime.
//
// Which workerd runs the stalled file isn't known here (each pool worker
// starts its own, and Vitest doesn't say which), so every workerd below
// the Vitest process is dumped. Everything is bounded: each command has a
// deadline and an output cap, and the whole dump has a deadline of its
// own, so a dump that hangs never holds the run it is ending.
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

/** One process as `ps` lists it. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

const psLine = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<command>.+?)\s*$/u;

/** The rows of `ps -A -o pid=,ppid=,comm=`; lines it can't read are skipped. */
export const parsePs = (text: string): ProcessRow[] =>
  text.split("\n").flatMap((line) => {
    const groups = psLine.exec(line)?.groups;
    if (groups === undefined) {
      return [];
    }
    return [
      {
        pid: Number(groups.pid),
        ppid: Number(groups.ppid),
        command: groups.command ?? "",
      },
    ];
  });

/** A command's program name: macOS's `comm` is a full path, Linux's isn't. */
const programOf = (command: string): string => command.split("/").at(-1) ?? "";

/** `text` cut to at most `maxBytes` of UTF-8, saying so when cut. */
export const truncated = (text: string, maxBytes: number): string => {
  const bytes = Buffer.from(text, "utf-8");
  if (bytes.byteLength <= maxBytes) {
    return text;
  }
  // A cut through a multi-byte character decodes to a replacement character.
  return `${bytes.subarray(0, maxBytes).toString("utf-8")}\n[cut at ${maxBytes} of ${bytes.byteLength} bytes]\n`;
};

/** What a bounded command may take, and what ends it early. */
export interface Bounds {
  timeoutMs: number;
  maxBytes: number;
  /** Kills the command once aborted. */
  signal?: AbortSignal;
}

/** What a bounded command answered. */
export interface Ran {
  /** stdout and stderr together, with a line saying why it ended early. */
  output: string;
  /** Whether it started at all. */
  started: boolean;
  /** Its exit code; null when it was killed or never started. */
  code: number | null;
}

/**
 * Runs a command and answers its output, never rejecting: a command that
 * can't start, outlives `timeoutMs`, writes more than `maxBytes` or is
 * aborted answers what it wrote with a line saying why it ended, and is
 * killed.
 */
export type RunCommand = (
  command: string,
  args: readonly string[],
  bounds: Bounds
) => Promise<Ran>;

export const runBounded: RunCommand = async (command, args, bounds) => {
  const { promise, resolve } = Promise.withResolvers<Ran>();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let note = "";
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const kill = (why: string): void => {
    note ||= why;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(() => {
    kill(`[ended after ${bounds.timeoutMs} ms]\n`);
  }, bounds.timeoutMs);
  const onAbort = (): void => {
    kill("[ended at the dump's deadline]\n");
  };
  if (bounds.signal?.aborted === true) {
    onAbort();
  }
  bounds.signal?.addEventListener("abort", onAbort, { once: true });
  const settle = (ran: Ran): void => {
    clearTimeout(timer);
    bounds.signal?.removeEventListener("abort", onAbort);
    resolve(ran);
  };
  const take = (chunk: Buffer): void => {
    if (bytes >= bounds.maxBytes) {
      return;
    }
    const kept = chunk.subarray(0, bounds.maxBytes - bytes);
    chunks.push(kept);
    bytes += kept.byteLength;
    if (bytes >= bounds.maxBytes) {
      kill(`[cut at ${bounds.maxBytes} bytes]\n`);
    }
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  child.on("error", (error) => {
    settle({
      output: `[${command} didn't run: ${error.message}]\n`,
      started: false,
      code: null,
    });
  });
  child.on("close", (code) => {
    settle({
      output: `${Buffer.concat(chunks).toString("utf-8")}${note}`,
      started: true,
      code,
    });
  });
  return await promise;
};

/** How long the whole dump may take, and how much it may print. */
export const dumpBounds: Bounds = { timeoutMs: 20_000, maxBytes: 300 * 1024 };

/** How long listing processes may take, at most. */
const psTimeoutMs = 5000;

/** How far apart the extra samples of a busy main thread are taken. */
const resampleMs = 500;

/** The pids of the processes running `program` below `root`, in pid order. */
export const programBelow = (
  rows: readonly ProcessRow[],
  root: number,
  program: string
): number[] => {
  const below = new Set<number>([root]);
  // Parents can have higher pids than their children, so look until no
  // more are found rather than in one pass.
  let grew = true;
  while (grew) {
    grew = false;
    for (const { pid, ppid } of rows) {
      if (below.has(ppid) && !below.has(pid)) {
        below.add(pid);
        grew = true;
      }
    }
  }
  return rows
    .filter(
      ({ pid, command }) =>
        pid !== root && below.has(pid) && programOf(command) === program
    )
    .map(({ pid }) => pid)
    .toSorted((a, b) => a - b);
};

/** The pids of the workerd processes anywhere below `root`, in pid order. */
export const workerdBelow = (
  rows: readonly ProcessRow[],
  root: number
): number[] => programBelow(rows, root, "workerd");

/** A frame of an event loop waiting in its poll: Linux's, then macOS's. */
const idlePoll = /\b(?:epoll_wait|kevent)\b/u;

/**
 * Whether gdb's `thread apply all bt` for process `pid` has its main thread
 * (the one whose LWP is the pid) anywhere but idle in its event loop's poll:
 * running JavaScript, a callback or the runtime. Without its stack (gdb
 * didn't answer) it isn't busy: sampling it again would tell nothing more.
 */
export const mainThreadBusy = (gdbOutput: string, pid: number): boolean => {
  const start = gdbOutput.indexOf(`(LWP ${pid})`);
  if (start === -1) {
    return false;
  }
  const next = gdbOutput.indexOf("\nThread ", start);
  return !idlePoll.test(gdbOutput.slice(start, next === -1 ? undefined : next));
};

/** The lines of `ss` output that belong to one of `pids`. */
export const socketsOf = (ssOutput: string, pids: readonly number[]): string =>
  ssOutput
    .split("\n")
    .filter((line) => pids.some((pid) => line.includes(`pid=${pid},`)))
    .join("\n");

/** What `process.report.getReport()` holds that the dump reads. */
interface NodeReport {
  javascriptStack?: { message?: string; stack?: readonly string[] };
  libuv?: readonly {
    type?: string;
    is_active?: boolean;
    is_referenced?: boolean;
    localEndpoint?: { host?: string; port?: number } | null;
    remoteEndpoint?: { host?: string; port?: number } | null;
  }[];
}

const endpoint = (
  at: { host?: string; port?: number } | null | undefined
): string => (at ? `${at.host ?? "?"}:${at.port ?? "?"}` : "-");

/**
 * A Node.js diagnostic report's JavaScript stack, and its open sockets and
 * pipes with their peers: what the Vitest process waits on.
 */
export const summariseReport = (report: unknown): string => {
  // SAFETY: a diagnostic report is Node.js's own documented JSON; every
  // field read below is optional, and a missing one prints as absent.
  const { javascriptStack, libuv = [] } = (report ?? {}) as NodeReport;
  const handles = libuv
    .filter(({ type }) => type === "tcp" || type === "pipe" || type === "udp")
    .map(
      ({ type, is_active, is_referenced, localEndpoint, remoteEndpoint }) =>
        `  ${type} ${endpoint(localEndpoint)} -> ${endpoint(remoteEndpoint)}${is_active === true ? " active" : ""}${is_referenced === true ? " referenced" : ""}`
    );
  return [
    `JavaScript stack: ${javascriptStack?.message ?? "(none)"}`,
    ...(javascriptStack?.stack ?? []).map((frame) => `  ${frame}`),
    `Sockets and pipes (${handles.length}):`,
    ...handles,
  ].join("\n");
};

/** This process's report, summarised: the Vitest process, when it ends a run. */
const ownReport = (): string => summariseReport(process.report.getReport());

/**
 * What a stalled run is stuck in, as one text of at most `bounds.maxBytes`,
 * within `bounds.timeoutMs`:
 *
 * - each workerd below process `root`: every thread's stack, by gdb. When
 *   its main thread isn't idle in its event loop, two more samples of that
 *   thread half a second apart (moving, or stuck in one place), and V8's
 *   own JavaScript stack of it, which V8 prints to workerd's stdout;
 * - the sockets of those workerd and of the node processes below `root`,
 *   with their peers, by `ss`;
 * - the Vitest process's own JavaScript stack and open sockets, from its
 *   Node.js diagnostic report.
 *
 * Each command has only the time left of the deadline; one that didn't end
 * by then is cut where it was and killed, and what ended is kept.
 */
export const dumpWorkerdStacks = async ({
  root,
  run = runBounded,
  bounds = dumpBounds,
  report = ownReport,
}: {
  root: number;
  run?: RunCommand;
  bounds?: Bounds;
  report?: () => string;
}): Promise<string> => {
  const deadline = Date.now() + bounds.timeoutMs;
  const left = (): number => Math.max(0, deadline - Date.now());
  // Aborted once the dump is done: a command still running then (one that
  // missed its own deadline) is killed before this returns.
  const stop = new AbortController();
  /** `answer` at the deadline, or once the dump is done. */
  const late = async <T>(answer: T): Promise<T> => {
    try {
      await wait(left(), undefined, { ref: false, signal: stop.signal });
    } catch {
      // Aborted: the dump is done, and the answer goes unread.
    }
    return answer;
  };
  /** `command`, given the time left and `maxBytes`, or a note at the deadline. */
  const bounded = async (
    command: string,
    args: readonly string[],
    maxBytes: number,
    timeoutMs = left()
  ): Promise<Ran> =>
    await Promise.race([
      run(command, args, { timeoutMs, maxBytes, signal: stop.signal }),
      late<Ran>({
        output: `[no answer by the dump's deadline, ${bounds.timeoutMs} ms]\n`,
        started: true,
        code: null,
      }),
    ]);
  /** A pause before another sample, ended early by the deadline. */
  const pause = async (): Promise<void> => {
    await late(true);
  };
  try {
    const listed = await bounded(
      "ps",
      ["-A", "-o", "pid=,ppid=,comm="],
      bounds.maxBytes,
      Math.min(psTimeoutMs, left())
    );
    if (!listed.started || listed.code !== 0) {
      return truncated(
        `Couldn't list the processes to find workerd (ps ${listed.started ? `ended with ${listed.code ?? "no exit code"}` : "didn't start"}):\n${listed.output}`,
        bounds.maxBytes
      );
    }
    const rows = parsePs(listed.output);
    const pids = workerdBelow(rows, root);
    const nodes = [root, ...programBelow(rows, root, "node")];
    // Most of the output for the stacks, shared so one workerd doesn't crowd
    // out the others; the rest for sockets and the Vitest process.
    const stackShare = Math.floor(
      (bounds.maxBytes * 0.7) / Math.max(1, pids.length)
    );
    const restShare = Math.floor(bounds.maxBytes * 0.15);
    const stacksOf = async (pid: number): Promise<string> => {
      const all = await bounded(
        "gdb",
        ["-batch", "-p", String(pid), "-ex", "thread apply all bt"],
        Math.floor(stackShare / 2)
      );
      const parts = [`--- workerd ${pid} ---\n${all.output}`];
      if (mainThreadBusy(all.output, pid)) {
        for (const sample of [2, 3]) {
          // One sample at a time, half a second apart: the point is whether
          // the thread moves between them.
          // oxlint-disable-next-line no-await-in-loop
          await Promise.race([
            wait(resampleMs, undefined, { ref: false }),
            pause(),
          ]);
          // oxlint-disable-next-line no-await-in-loop
          const again = await bounded(
            "gdb",
            ["-batch", "-p", String(pid), "-ex", "thread apply 1 bt 40"],
            Math.floor(stackShare / 8)
          );
          parts.push(
            `--- workerd ${pid}: main thread busy, sample ${sample} ---\n${again.output}`
          );
        }
        const js = await bounded(
          "gdb",
          [
            "-batch",
            "-p",
            String(pid),
            "-ex",
            "thread 1",
            "-ex",
            "call (void)_v8_internal_Print_StackTrace()",
          ],
          Math.floor(stackShare / 8)
        );
        parts.push(
          `--- workerd ${pid}: V8's JavaScript stack, printed to workerd's stdout ---\n${js.output}`
        );
      }
      return truncated(parts.join("\n"), stackShare);
    };
    const [stacks, sockets] = await Promise.all([
      Promise.all(pids.map(stacksOf)),
      bounded("ss", ["-tanpx"], bounds.maxBytes),
    ]);
    let own: string;
    try {
      own = report();
    } catch (error) {
      own = `[no report: ${error instanceof Error ? error.message : String(error)}]`;
    }
    return truncated(
      [
        pids.length === 0
          ? `No workerd runs below the Vitest process (${root}).\n`
          : stacks.join("\n"),
        `--- sockets of workerd ${pids.join(", ") || "(none)"} and node ${nodes.join(", ")}, by ss ---`,
        truncated(
          sockets.started && sockets.code === 0
            ? socketsOf(sockets.output, [...pids, ...nodes])
            : sockets.output,
          restShare
        ),
        `--- the Vitest process (node ${root}), by its diagnostic report ---`,
        truncated(own, restShare),
        "",
      ].join("\n"),
      bounds.maxBytes
    );
  } finally {
    stop.abort();
  }
};
