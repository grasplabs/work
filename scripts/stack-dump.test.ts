import { describe, expect, it } from "vite-plus/test";

import {
  dumpWorkerdStacks,
  parsePs,
  runBounded,
  truncated,
  workerdBelow,
} from "./stack-dump.ts";
import type { Bounds, Ran, RunCommand } from "./stack-dump.ts";

/** `ps -A -o pid=,ppid=,comm=` on a CI runner: Vitest is 100. */
const psOnLinux = `    1     0 systemd
  100     1 node
  130   100 node
  150   100 workerd
  210   130 workerd
   90   210 workerd
  300     1 workerd
  400   100 esbuild
garbage line
`;

const exited = (output: string): Ran => ({ output, started: true, code: 0 });

/**
 * A `run` that answers `ps` with `listing`, and gdb with `stack(pid,
 * bounds)`: the command each was asked for, by name and arguments.
 */
const fakeRun = (
  listing: Ran,
  stack: (pid: string, bounds: Bounds) => Promise<Ran> | Ran = (pid) =>
    exited(`#0 epoll_wait in workerd ${pid}\n`)
) => {
  const calls: string[][] = [];
  const run: RunCommand = async (command, args, bounds) => {
    await Promise.resolve();
    calls.push([command, ...args]);
    return command === "ps" ? listing : await stack(args[2] ?? "", bounds);
  };
  return { run, calls };
};

describe("which processes are dumped", () => {
  it("is every workerd below the Vitest process, at any depth, and nothing else", () => {
    expect(workerdBelow(parsePs(psOnLinux), 100)).toStrictEqual([90, 150, 210]);
  });

  it("knows workerd by its program name, as macOS lists a full path", () => {
    const rows = parsePs(
      "  100     1 /usr/local/bin/node\n  150   100 /repo/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd\n  160   100 /bin/workerd-helper\n"
    );
    expect(workerdBelow(rows, 100)).toStrictEqual([150]);
  });

  it("is none when no workerd runs below it", () => {
    expect(workerdBelow(parsePs(psOnLinux), 400)).toStrictEqual([]);
  });
});

describe("the stack dump", () => {
  it("asks gdb for every thread of each workerd below the Vitest process", async () => {
    const { run, calls } = fakeRun(exited(psOnLinux));
    const dump = await dumpWorkerdStacks({ root: 100, run });

    expect({
      gdb: calls.filter(([command]) => command === "gdb"),
      dump,
    }).toStrictEqual({
      gdb: ["90", "150", "210"].map((pid) => [
        "gdb",
        "-batch",
        "-p",
        pid,
        "-ex",
        "thread apply all bt",
      ]),
      dump: ["90", "150", "210"]
        .map(
          (pid) => `--- workerd ${pid} ---\n#0 epoll_wait in workerd ${pid}\n`
        )
        .join("\n"),
    });
  });

  it("says so when no workerd runs, without running gdb", async () => {
    const { run, calls } = fakeRun(exited("  100     1 node\n"));
    const dump = await dumpWorkerdStacks({ root: 100, run });

    expect({ commands: calls.map(([command]) => command), dump }).toStrictEqual(
      {
        commands: ["ps"],
        dump: "No workerd runs below the Vitest process (100).\n",
      }
    );
  });

  it("says ps couldn't list the processes, rather than that no workerd runs", async () => {
    const notStarted = fakeRun({
      output: "[ps didn't run: spawn ps ENOENT]\n",
      started: false,
      code: null,
    });
    const failed = fakeRun({
      output: "ps: bad option\n",
      started: true,
      code: 1,
    });

    expect({
      notStarted: await dumpWorkerdStacks({ root: 100, run: notStarted.run }),
      failed: await dumpWorkerdStacks({ root: 100, run: failed.run }),
      gdb: [...notStarted.calls, ...failed.calls].filter(
        ([command]) => command === "gdb"
      ),
    }).toStrictEqual({
      notStarted:
        "Couldn't list the processes to find workerd (ps didn't start):\n[ps didn't run: spawn ps ENOENT]\n",
      failed:
        "Couldn't list the processes to find workerd (ps ended with 1):\nps: bad option\n",
      gdb: [],
    });
  });

  it("prints at most its byte limit, sharing it between the processes", async () => {
    const { run } = fakeRun(exited(psOnLinux), (pid) =>
      exited(`${pid}:${"x".repeat(5000)}`)
    );
    const dump = await dumpWorkerdStacks({
      root: 100,
      run,
      bounds: { timeoutMs: 1000, maxBytes: 3000 },
    });

    expect({
      withinLimit: Buffer.byteLength(dump) <= 3000 + 100,
      everyProcess: ["90:", "150:", "210:"].every((head) =>
        dump.includes(head)
      ),
      saysCut: dump.includes("[cut at 1000 of"),
    }).toStrictEqual({ withinLimit: true, everyProcess: true, saysCut: true });
  });

  it("keeps the dumps that ended when one doesn't by the deadline, and kills that one", async () => {
    const killed: string[] = [];
    const { run } = fakeRun(exited(psOnLinux), async (pid, { signal }) => {
      if (pid !== "150") {
        return exited(`#0 epoll_wait in workerd ${pid}\n`);
      }
      // Hangs until the dump kills it, as runBounded does on abort.
      const { promise, resolve } = Promise.withResolvers<Ran>();
      signal?.addEventListener("abort", () => {
        killed.push(pid);
        resolve({ output: "", started: true, code: null });
      });
      return await promise;
    });
    const started = Date.now();
    const dump = await dumpWorkerdStacks({
      root: 100,
      run,
      bounds: { timeoutMs: 100, maxBytes: 3000 },
    });

    expect({
      dump,
      killed,
      inTime: Date.now() - started < 5000,
    }).toStrictEqual({
      dump: [
        "--- workerd 90 ---\n#0 epoll_wait in workerd 90\n",
        "--- workerd 150 ---\n[no answer by the dump's deadline, 100 ms]\n",
        "--- workerd 210 ---\n#0 epoll_wait in workerd 210\n",
      ].join("\n"),
      killed: ["150"],
      inTime: true,
    });
  });

  it("gives each gdb only the time left of the dump's deadline", async () => {
    const asked: number[] = [];
    const { run } = fakeRun(exited(psOnLinux), (pid, { timeoutMs }) => {
      asked.push(timeoutMs);
      return exited(pid);
    });
    await dumpWorkerdStacks({
      root: 100,
      run,
      bounds: { timeoutMs: 2000, maxBytes: 3000 },
    });

    expect(
      asked.every((timeoutMs) => timeoutMs > 0 && timeoutMs <= 2000)
    ).toBeTruthy();
  });
});

describe("a bounded command", () => {
  it("answers what a command wrote, stdout and stderr, and its exit code", async () => {
    const { output, started, code } = await runBounded(
      process.execPath,
      [
        "-e",
        "process.stdout.write('out '); process.stderr.write('err'); process.exitCode = 3",
      ],
      { timeoutMs: 30_000, maxBytes: 1000 }
    );
    expect({
      output: output.split(" ").toSorted(),
      started,
      code,
    }).toStrictEqual({ output: ["err", "out"], started: true, code: 3 });
  });

  it("kills a command past its deadline and says so", async () => {
    const ran = await runBounded(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { timeoutMs: 300, maxBytes: 1000 }
    );
    expect(ran).toStrictEqual({
      output: "[ended after 300 ms]\n",
      started: true,
      code: null,
    });
  });

  it("kills a command once its signal aborts, and says so", async () => {
    const stop = new AbortController();
    const running = runBounded(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { timeoutMs: 60_000, maxBytes: 1000, signal: stop.signal }
    );
    stop.abort();
    await expect(running).resolves.toStrictEqual({
      output: "[ended at the dump's deadline]\n",
      started: true,
      code: null,
    });
  });

  it("kills a command that writes past its byte limit, keeping that much", async () => {
    const { output } = await runBounded(
      process.execPath,
      ["-e", "setInterval(() => process.stdout.write('y'.repeat(4096)), 1)"],
      { timeoutMs: 30_000, maxBytes: 10_000 }
    );
    expect(output).toBe(`${"y".repeat(10_000)}[cut at 10000 bytes]\n`);
  });

  it("answers why when the command doesn't exist", async () => {
    const ran = await runBounded("grasp-no-such-command", [], {
      timeoutMs: 1000,
      maxBytes: 1000,
    });
    expect({
      started: ran.started,
      saysWhy: /^\[grasp-no-such-command didn't run: .*ENOENT/u.test(
        ran.output
      ),
    }).toStrictEqual({ started: false, saysWhy: true });
  });
});

describe("cutting text", () => {
  it("leaves text within the limit as it is", () => {
    expect(truncated("abc", 3)).toBe("abc");
  });

  it("cuts by UTF-8 bytes and says how much there was", () => {
    expect(truncated("ab€cd", 4)).toBe("ab�\n[cut at 4 of 7 bytes]\n");
  });
});
