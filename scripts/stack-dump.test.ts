import { describe, expect, it } from "vite-plus/test";

import {
  dumpWorkerdStacks,
  mainThreadBusy,
  parsePs,
  runBounded,
  socketsOf,
  summariseReport,
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

/** `ss -tanpx` on that runner. */
const ssOnLinux = `Netid State  Local Address:Port Peer Address:Port Process
tcp   ESTAB  127.0.0.1:41000     127.0.0.1:8787    users:(("node",pid=100,fd=30))
tcp   ESTAB  127.0.0.1:8787      127.0.0.1:41000   users:(("workerd",pid=150,fd=12))
tcp   LISTEN 0.0.0.0:22          0.0.0.0:*         users:(("sshd",pid=7,fd=3))
u_str ESTAB  * 5000              * 5001            users:(("workerd",pid=300,fd=5))
`;

const exited = (output: string): Ran => ({ output, started: true, code: 0 });

/** gdb's stacks of a workerd whose main thread waits in its event loop. */
const idle = (pid: string): string =>
  `Thread 2 (Thread 0x7f01 (LWP 9${pid}) "V8 DefaultWorke"):\n#0 syscall ()\n\nThread 1 (Thread 0x7f00 (LWP ${pid}) "workerd"):\n#0 epoll_wait ()\n#1 kj::EventLoop::wait() ()\n`;

/** gdb's stacks of a workerd whose main thread runs a timer's callback. */
const busy = (pid: string): string =>
  `Thread 1 (Thread 0x7f00 (LWP ${pid}) "workerd"):\n#0 v8::internal::Isolate::UnregisterTryCatchHandler ()\n#1 workerd::IoContext::runImpl ()\n`;

/**
 * A `run` that answers `ps` with `listing`, `ss` with `sockets`, and gdb
 * with `gdb(pid, args, bounds)`: the commands it was asked for, by name and
 * arguments.
 */
const fakeRun = (
  listing: Ran,
  gdb: (
    pid: string,
    args: readonly string[],
    bounds: Bounds
  ) => Promise<Ran> | Ran = (pid) => exited(idle(pid)),
  sockets: Ran = exited(ssOnLinux)
) => {
  const calls: string[][] = [];
  const run: RunCommand = async (command, args, bounds) => {
    await Promise.resolve();
    calls.push([command, ...args]);
    if (command === "ps") {
      return listing;
    }
    if (command === "ss") {
      return sockets;
    }
    return await gdb(args[2] ?? "", args, bounds);
  };
  return { run, calls };
};

const report = (): string => "JavaScript stack: (the Vitest process)";

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

describe("reading what was dumped", () => {
  it("takes a main thread in its event loop's poll as idle, one anywhere else as busy, and none without its stack", () => {
    expect([
      mainThreadBusy(idle("150"), 150),
      mainThreadBusy(busy("150"), 150),
      mainThreadBusy("[gdb didn't run: spawn gdb ENOENT]\n", 150),
    ]).toStrictEqual([false, true, false]);
  });

  it("keeps the sockets of the given processes only", () => {
    expect(socketsOf(ssOnLinux, [100, 150]).split("\n")).toStrictEqual([
      'tcp   ESTAB  127.0.0.1:41000     127.0.0.1:8787    users:(("node",pid=100,fd=30))',
      'tcp   ESTAB  127.0.0.1:8787      127.0.0.1:41000   users:(("workerd",pid=150,fd=12))',
    ]);
  });

  it("reads a Node.js report's JavaScript stack and its sockets and pipes with their peers", () => {
    expect(
      summariseReport({
        javascriptStack: {
          message: "No stack.",
          stack: ["Unavailable."],
        },
        libuv: [
          {
            type: "tcp",
            is_active: true,
            is_referenced: true,
            localEndpoint: { host: "127.0.0.1", port: 41_000 },
            remoteEndpoint: { host: "127.0.0.1", port: 8787 },
          },
          { type: "timer", is_active: true },
          { type: "pipe", is_active: false, localEndpoint: null },
        ],
      }).split("\n")
    ).toStrictEqual([
      "JavaScript stack: No stack.",
      "  Unavailable.",
      "Sockets and pipes (2):",
      "  tcp 127.0.0.1:41000 -> 127.0.0.1:8787 active referenced",
      "  pipe - -> -",
    ]);
  });
});

describe("the stall dump", () => {
  it("asks gdb once for every thread of each idle workerd, and adds their sockets and the Vitest process", async () => {
    const { run, calls } = fakeRun(exited(psOnLinux));
    const dump = await dumpWorkerdStacks({ root: 100, run, report });

    expect({
      gdb: calls.filter(([command]) => command === "gdb"),
      stacks: ["90", "150", "210"].every((pid) =>
        dump.includes(`--- workerd ${pid} ---\n${idle(pid)}`)
      ),
      sockets: dump.includes(
        `--- sockets of workerd 90, 150, 210 and node 100, 130, by ss ---\n${socketsOf(ssOnLinux, [100, 150])}\n`
      ),
      vitest: dump.includes(
        "--- the Vitest process (node 100), by its diagnostic report ---\nJavaScript stack: (the Vitest process)"
      ),
    }).toStrictEqual({
      gdb: ["90", "150", "210"].map((pid) => [
        "gdb",
        "-batch",
        "-p",
        pid,
        "-ex",
        "thread apply all bt",
      ]),
      stacks: true,
      sockets: true,
      vitest: true,
    });
  });

  it("samples a busy main thread twice more and asks V8 for its JavaScript stack, for that workerd only", async () => {
    const { run, calls } = fakeRun(exited(psOnLinux), (pid) =>
      exited(pid === "150" ? busy(pid) : idle(pid))
    );
    const dump = await dumpWorkerdStacks({ root: 100, run, report });

    expect({
      gdb: calls
        .filter(([command]) => command === "gdb")
        .map((args) => args.slice(3).join(" ")),
      samples: [2, 3].every((sample) =>
        dump.includes(
          `--- workerd 150: main thread busy, sample ${sample} ---\n${busy("150")}`
        )
      ),
      javascript: dump.includes(
        "--- workerd 150: V8's JavaScript stack, printed to workerd's stdout ---"
      ),
    }).toStrictEqual({
      gdb: [
        "90 -ex thread apply all bt",
        "150 -ex thread apply all bt",
        "210 -ex thread apply all bt",
        "150 -ex thread apply 1 bt 40",
        "150 -ex thread apply 1 bt 40",
        "150 -ex thread 1 -ex call (void)_v8_internal_Print_StackTrace()",
      ],
      samples: true,
      javascript: true,
    });
  });

  it("says so when no workerd runs, without running gdb, and still adds the sockets and the Vitest process", async () => {
    const { run, calls } = fakeRun(exited("  100     1 node\n"));
    const dump = await dumpWorkerdStacks({ root: 100, run, report });

    expect({
      commands: calls.map(([command]) => command),
      none: dump.startsWith(
        "No workerd runs below the Vitest process (100).\n"
      ),
      vitest: dump.includes("JavaScript stack: (the Vitest process)"),
    }).toStrictEqual({ commands: ["ps", "ss"], none: true, vitest: true });
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
      notStarted: await dumpWorkerdStacks({
        root: 100,
        run: notStarted.run,
        report,
      }),
      failed: await dumpWorkerdStacks({ root: 100, run: failed.run, report }),
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

  it("says why when ss can't list the sockets", async () => {
    const { run } = fakeRun(exited(psOnLinux), undefined, {
      output: "[ss didn't run: spawn ss ENOENT]\n",
      started: false,
      code: null,
    });
    const dump = await dumpWorkerdStacks({ root: 100, run, report });

    expect(dump).toContain("by ss ---\n[ss didn't run: spawn ss ENOENT]\n");
  });

  it("prints at most its byte limit, sharing it between the processes", async () => {
    const { run } = fakeRun(exited(psOnLinux), (pid) =>
      exited(`${idle(pid)}${"x".repeat(5000)}`)
    );
    const dump = await dumpWorkerdStacks({
      root: 100,
      run,
      report,
      bounds: { timeoutMs: 1000, maxBytes: 6000 },
    });

    expect({
      withinLimit: Buffer.byteLength(dump) <= 6000 + 100,
      everyProcess: ["90", "150", "210"].every((pid) =>
        dump.includes(`--- workerd ${pid} ---`)
      ),
      saysCut: dump.includes("[cut at"),
    }).toStrictEqual({ withinLimit: true, everyProcess: true, saysCut: true });
  });

  it("keeps the dumps that ended when one doesn't by the deadline, and kills that one", async () => {
    const killed: string[] = [];
    const { run } = fakeRun(
      exited(psOnLinux),
      async (pid, _args, { signal }) => {
        if (pid !== "150") {
          return exited(idle(pid));
        }
        // Hangs until the dump kills it, as runBounded does on abort.
        const { promise, resolve } = Promise.withResolvers<Ran>();
        signal?.addEventListener("abort", () => {
          killed.push(pid);
          resolve({ output: "", started: true, code: null });
        });
        return await promise;
      }
    );
    const started = Date.now();
    const dump = await dumpWorkerdStacks({
      root: 100,
      run,
      report,
      bounds: { timeoutMs: 100, maxBytes: 6000 },
    });

    expect({
      kept: ["90", "210"].every((pid) =>
        dump.includes(`--- workerd ${pid} ---\n${idle(pid)}`)
      ),
      cut: dump.includes(
        "--- workerd 150 ---\n[no answer by the dump's deadline, 100 ms]\n"
      ),
      killed,
      inTime: Date.now() - started < 5000,
    }).toStrictEqual({ kept: true, cut: true, killed: ["150"], inTime: true });
  });

  it("gives each command only the time left of the dump's deadline", async () => {
    const asked: number[] = [];
    const { run } = fakeRun(exited(psOnLinux), (pid, _args, { timeoutMs }) => {
      asked.push(timeoutMs);
      return exited(pid === "150" ? busy(pid) : idle(pid));
    });
    await dumpWorkerdStacks({
      root: 100,
      run,
      report,
      bounds: { timeoutMs: 2000, maxBytes: 6000 },
    });

    expect({
      asked: asked.length,
      withinDeadline: asked.every(
        (timeoutMs) => timeoutMs >= 0 && timeoutMs <= 2000
      ),
    }).toStrictEqual({ asked: 6, withinDeadline: true });
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
