import { describe, expect, it } from "vite-plus/test";

import {
  dumpWorkerdStacks,
  parsePs,
  runBounded,
  truncated,
  workerdBelow,
} from "./stack-dump.ts";
import type { RunCommand } from "./stack-dump.ts";

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

/** A `run` that answers `ps` with `listing` and gdb with a stack per pid. */
const fakeRun = (
  listing: string,
  stack = (pid: string) => `#0 epoll_wait in workerd ${pid}\n`
) => {
  const calls: string[][] = [];
  const run: RunCommand = async (command, args) => {
    await Promise.resolve();
    calls.push([command, ...args]);
    return command === "ps" ? listing : stack(args[2] ?? "");
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
    const { run, calls } = fakeRun(psOnLinux);
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
    const { run, calls } = fakeRun("  100     1 node\n");
    const dump = await dumpWorkerdStacks({ root: 100, run });

    expect({ commands: calls.map(([command]) => command), dump }).toStrictEqual(
      {
        commands: ["ps"],
        dump: "No workerd runs below the Vitest process (100).\n",
      }
    );
  });

  it("prints at most its byte limit, sharing it between the processes", async () => {
    const { run } = fakeRun(psOnLinux, (pid) => `${pid}:${"x".repeat(5000)}`);
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

  it("ends at its deadline when a command never does", async () => {
    const run: RunCommand = async (command) =>
      command === "ps"
        ? psOnLinux
        : await Promise.withResolvers<string>().promise;
    const started = Date.now();
    const dump = await dumpWorkerdStacks({
      root: 100,
      run,
      bounds: { timeoutMs: 50, maxBytes: 3000 },
    });

    expect({
      dump,
      inTime: Date.now() - started < 1000,
    }).toStrictEqual({
      dump: "[the stack dump didn't end within 50 ms]\n",
      inTime: true,
    });
  });
});

describe("a bounded command", () => {
  it("answers what a command wrote, stdout and stderr", async () => {
    const output = await runBounded(
      process.execPath,
      ["-e", "process.stdout.write('out '); process.stderr.write('err')"],
      { timeoutMs: 10_000, maxBytes: 1000 }
    );
    expect(output.split(" ").toSorted()).toStrictEqual(["err", "out"]);
  });

  it("kills a command past its deadline and says so", async () => {
    const started = Date.now();
    const output = await runBounded(
      process.execPath,
      ["-e", "process.stdout.write('started'); setInterval(() => {}, 1000)"],
      { timeoutMs: 300, maxBytes: 1000 }
    );
    expect({ output, inTime: Date.now() - started < 5000 }).toStrictEqual({
      output: "started[ended after 300 ms]\n",
      inTime: true,
    });
  });

  it("kills a command that writes past its byte limit, keeping that much", async () => {
    const output = await runBounded(
      process.execPath,
      ["-e", "setInterval(() => process.stdout.write('y'.repeat(4096)), 1)"],
      { timeoutMs: 10_000, maxBytes: 10_000 }
    );
    expect(output).toBe(`${"y".repeat(10_000)}[cut at 10000 bytes]\n`);
  });

  it("answers why when the command doesn't exist", async () => {
    const output = await runBounded("grasp-no-such-command", [], {
      timeoutMs: 1000,
      maxBytes: 1000,
    });
    expect(output).toMatch(/^\[grasp-no-such-command didn't run: .*ENOENT/u);
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
