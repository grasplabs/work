// The thread stacks of every workerd the Vitest process started, for the
// stall reporter (stall-reporter.ts) to print before it ends a stalled run.
// A stall in a Worker test leaves workerd idle or blocked with nothing in
// the log to say where; its native stacks show whether it waits in its
// event loop, runs JavaScript, or is stuck in the runtime itself.
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

/** The pids of the workerd processes anywhere below `root`, in pid order. */
export const workerdBelow = (
  rows: readonly ProcessRow[],
  root: number
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
        pid !== root && below.has(pid) && programOf(command) === "workerd"
    )
    .map(({ pid }) => pid)
    .toSorted((a, b) => a - b);
};

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

/**
 * The thread stacks of every workerd below process `root`, by gdb, as one
 * text of at most `bounds.maxBytes`, within `bounds.timeoutMs`: each gdb
 * has only the time left of that, a dump that didn't end by then is cut
 * where it was and its gdb killed, and the dumps that ended are kept.
 */
export const dumpWorkerdStacks = async ({
  root,
  run = runBounded,
  bounds = dumpBounds,
}: {
  root: number;
  run?: RunCommand;
  bounds?: Bounds;
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
  try {
    const listed = await Promise.race([
      run("ps", ["-A", "-o", "pid=,ppid=,comm="], {
        timeoutMs: Math.min(psTimeoutMs, left()),
        maxBytes: bounds.maxBytes,
        signal: stop.signal,
      }),
      late<Ran>({
        output: "[no answer by the dump's deadline]\n",
        started: true,
        code: null,
      }),
    ]);
    if (!listed.started || listed.code !== 0) {
      return truncated(
        `Couldn't list the processes to find workerd (ps ${listed.started ? `ended with ${listed.code ?? "no exit code"}` : "didn't start"}):\n${listed.output}`,
        bounds.maxBytes
      );
    }
    const pids = workerdBelow(parsePs(listed.output), root);
    if (pids.length === 0) {
      return `No workerd runs below the Vitest process (${root}).\n`;
    }
    // At once, each with a share of the output, so one doesn't crowd out
    // the others.
    const share = Math.floor(bounds.maxBytes / pids.length);
    const stacks = await Promise.all(
      pids.map(async (pid) => {
        const ran = await Promise.race([
          run(
            "gdb",
            ["-batch", "-p", String(pid), "-ex", "thread apply all bt"],
            { timeoutMs: left(), maxBytes: share, signal: stop.signal }
          ),
          late<Ran>({
            output: `[no answer by the dump's deadline, ${bounds.timeoutMs} ms]\n`,
            started: true,
            code: null,
          }),
        ]);
        return `--- workerd ${pid} ---\n${truncated(ran.output, share)}`;
      })
    );
    return truncated(stacks.join("\n"), bounds.maxBytes);
  } finally {
    stop.abort();
  }
};
