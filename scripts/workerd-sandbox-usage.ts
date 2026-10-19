/**
 * What a sandbox process uses, as the supervisor (workerd-sandbox.ts) reads
 * it while a call runs: its resident memory and its CPU time, so it can end
 * a call that passes either bound. One rule throughout: a reading is
 * `gone` only once the process's exit is confirmed; anything else that
 * isn't a reading is `unreadable`, which fails the call, never skips it.
 * A bound that silently stopped applying would leave App code unbounded.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Where a process's usage is read: Linux's procfs, or macOS's `ps`. */
export interface UsageProbe {
  /** Linux: the procfs root, `/proc`. */
  procRoot: string;
  /** macOS: the `ps` binary, by absolute path so no PATH can hide it. */
  ps: string;
  /** Which of the two to read: this machine's own platform by default. */
  platform?: NodeJS.Platform;
}

export const defaultUsageProbe: UsageProbe = {
  procRoot: "/proc",
  ps: "/bin/ps",
};

/** What reading a process's usage came to. */
export type UsageReading =
  | { kind: "usage"; rssBytes: number; cpuMs: number }
  | { kind: "gone" }
  | { kind: "unreadable"; why: string };

/** Settles once `child` is gone, whether it exited or never started. */
const exitOf = async (child: ChildProcess): Promise<void> => {
  try {
    await once(child, "exit");
  } catch {
    // It never started: `error` instead of `exit`.
  }
};

/**
 * Whether `pid` is confirmed gone: the supervisor saw it exit (`exited`),
 * or the system has no such process at all (`ESRCH`; a zombie we still
 * hold isn't that). Nothing else counts.
 */
const confirmedGone = (pid: number, exited: () => boolean): boolean => {
  if (exited()) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
};

/** Gone if confirmed, otherwise unreadable for `why`. */
const goneOr = (
  pid: number,
  exited: () => boolean,
  why: string
): UsageReading =>
  confirmedGone(pid, exited) ? { kind: "gone" } : { kind: "unreadable", why };

const vmRss = /^VmRSS:\s+(?<kib>\d+)\s+kB$/mu;

/**
 * `/proc/<pid>/stat` after the command's closing parenthesis (the command
 * may hold spaces and parentheses itself): the state (3rd field), `flags`
 * (9th), then `utime` and `stime` (14th and 15th), in clock ticks.
 */
const procStat =
  /\)\s+(?<state>\S)(?:\s+\S+){5}\s+(?<flags>\d+)(?:\s+\S+){4}\s+(?<utime>\d+)\s+(?<stime>\d+)/u;

/**
 * The kernel's `PF_EXITING` in a task's `flags`: set as the task starts to
 * exit, before it lets go of its memory (`VmRSS` leaves its status then)
 * and well before it's a zombie (`Z`). Never cleared: it can't come back.
 */
const exitingFlag = 0x4;

/** Clock ticks per second in procfs: `USER_HZ`, 100 on every Linux ABI. */
const userHz = 100;

/**
 * `pid`'s usage on Linux: memory from `<procRoot>/<pid>/status`, CPU time
 * from `stat`. Its own state `Z` or `X`, or `PF_EXITING` in its flags, says
 * it exited or is exiting, though `kill(pid, 0)` still finds it until it's
 * reaped: a crash mid-call is the App's.
 *
 * `stat` is read after `status`, never alongside it: a status without
 * `VmRSS` from a process exiting meanwhile then always meets a `stat` that
 * says so, never one from before it began to exit.
 */
const procUsage = async (
  procRoot: string,
  pid: number,
  exited: () => boolean
): Promise<UsageReading> => {
  let status: string;
  let stat: string;
  try {
    status = await readFile(
      path.join(procRoot, String(pid), "status"),
      "utf-8"
    );
    stat = await readFile(path.join(procRoot, String(pid), "stat"), "utf-8");
  } catch (error) {
    return goneOr(pid, exited, String(error));
  }
  const fields = procStat.exec(stat)?.groups;
  // oxlint-disable-next-line no-bitwise -- the kernel's task flags
  const exiting = (Number(fields?.flags ?? 0) & exitingFlag) !== 0;
  if (fields?.state === "Z" || fields?.state === "X" || exiting) {
    return { kind: "gone" };
  }
  const kib = vmRss.exec(status)?.groups?.kib;
  if (kib === undefined || fields?.utime === undefined) {
    return goneOr(pid, exited, "no VmRSS or CPU time in its procfs entry");
  }
  return {
    kind: "usage",
    rssBytes: Number(kib) * 1024,
    cpuMs: ((Number(fields.utime) + Number(fields.stime)) * 1000) / userHz,
  };
};

/** `ps -o stat=,rss=,time=`: the state, KiB resident, `[[dd-]hh:]mm:ss.cc`. */
const psOutput =
  /^(?<state>\S+)\s+(?<kib>\d+)\s+(?:(?:(?<days>\d+)-)?(?<hours>\d+):)?(?<minutes>\d+):(?<seconds>\d+(?:\.\d+)?)$/u;

/** `pid`'s usage on macOS, as `ps` says, with its state. */
const psUsage = async (
  ps: string,
  pid: number,
  exited: () => boolean
): Promise<UsageReading> => {
  const child = spawn(ps, ["-o", "stat=,rss=,time=", "-p", String(pid)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const done = exitOf(child);
  let output = "";
  try {
    for await (const chunk of child.stdout) {
      output += String(chunk);
    }
  } catch (error) {
    await done;
    return goneOr(pid, exited, String(error));
  }
  await done;
  const parsed = psOutput.exec(output.trim())?.groups;
  if (parsed?.state?.startsWith("Z") === true) {
    // Exited, a zombie until reaped: gone, as on Linux.
    return { kind: "gone" };
  }
  if (parsed?.kib === undefined || parsed.seconds === undefined) {
    return goneOr(
      pid,
      exited,
      `ps answered ${JSON.stringify(output.trim())} (exit ${child.exitCode})`
    );
  }
  const seconds =
    Number(parsed.days ?? 0) * 86_400 +
    Number(parsed.hours ?? 0) * 3600 +
    Number(parsed.minutes) * 60 +
    Number(parsed.seconds);
  return {
    kind: "usage",
    rssBytes: Number(parsed.kib) * 1024,
    cpuMs: seconds * 1000,
  };
};

/**
 * `pid`'s usage, or that it's confirmed gone. Anything else is
 * `unreadable`, never skipped: then nothing would bound it.
 */
export const processUsage = async (
  probe: UsageProbe,
  pid: number,
  exited: () => boolean
): Promise<UsageReading> => {
  const platform = probe.platform ?? process.platform;
  try {
    if (platform === "linux") {
      return await procUsage(probe.procRoot, pid, exited);
    }
    if (platform === "darwin") {
      return await psUsage(probe.ps, pid, exited);
    }
    return goneOr(pid, exited, `no way to read usage on ${platform}`);
  } catch (error) {
    // A reader that throws (`spawn` refused, say) reads nothing.
    return goneOr(pid, exited, String(error));
  }
};

/**
 * Refuses a usage source that doesn't work here, before any App code runs:
 * reading this process's own usage as a child's would be read. Without one,
 * nothing would bound memory or CPU time.
 */
export const checkUsageProbe = async (probe: UsageProbe): Promise<void> => {
  const platform = probe.platform ?? process.platform;
  const reading = await processUsage(probe, process.pid, () => false);
  if (reading.kind !== "usage") {
    const sources: Partial<Record<NodeJS.Platform, string>> = {
      linux: path.join(probe.procRoot, String(process.pid)),
      darwin: probe.ps,
    };
    const source = sources[platform] ?? "nothing";
    throw new Error(
      `The sandbox can't read processes' memory or CPU time on ${platform} (from ${source}), so it would run App code without those bounds: ${reading.kind === "unreadable" ? reading.why : "no reading"}.`
    );
  }
};

/** The bounds a call's process is watched against. */
export interface UsageBounds {
  memoryLimitBytes: number;
  /** CPU time the call may use, past what its process had used before it. */
  cpuLimitMs?: number;
  pollMs: number;
}

/** Why a watch ended. */
export type WatchEnding =
  | { kind: "memory" }
  | { kind: "cpu" }
  | { kind: "unreadable"; why: string }
  | { kind: "ended" };

/**
 * Watches `pid` until `signal` aborts, a bound is passed, or its usage
 * can't be read. Its CPU time is counted from the first reading: what the
 * process used to start isn't the call's.
 */
export const watchUsage = async (
  probe: UsageProbe,
  pid: number,
  exited: () => boolean,
  { memoryLimitBytes, cpuLimitMs, pollMs }: UsageBounds,
  signal: AbortSignal
): Promise<WatchEnding> => {
  let baselineMs: number | undefined;
  while (!signal.aborted) {
    // oxlint-disable-next-line no-await-in-loop -- read once per poll
    const reading = await processUsage(probe, pid, exited);
    if (reading.kind === "unreadable") {
      return reading;
    }
    if (reading.kind === "usage") {
      baselineMs ??= reading.cpuMs;
      if (reading.rssBytes > memoryLimitBytes) {
        return { kind: "memory" };
      }
      if (cpuLimitMs !== undefined && reading.cpuMs - baselineMs > cpuLimitMs) {
        return { kind: "cpu" };
      }
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- one poll at a time
      await sleep(pollMs, undefined, { signal });
    } catch {
      return { kind: "ended" };
    }
  }
  return { kind: "ended" };
};
