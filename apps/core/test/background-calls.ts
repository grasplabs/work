/**
 * The calls into core's Worker module the test pool makes on core's
 * behalf, so a file ends only once they've gone quiet
 * (start-each-file.ts).
 *
 * In this pool every call into a Durable Object, and every `SELF` call,
 * first imports the Worker's main module through Vitest's module runner,
 * which asks Vitest's main process to resolve it over the file's RPC
 * channel. Vitest closes that channel once the file's tests end, and fails
 * a resolve still out with "Closing rpc while "resolve" was pending", an
 * unhandled rejection that fails the run after every test passed. Such a
 * call needn't be the tests' own: a workflow run a test left going takes
 * its next steps after the last test, audits each one (an audit drain
 * calls the AuditLog object) and, as it ends, wakes the steps queued for
 * its share (`wakeQueueFronts`, an engine call) (GRA-880).
 *
 * So the runner's `import` is counted here: how many started, and how
 * many are still out. The pool looks it up on its global
 * (`__vitest_mocker__.moduleRunner`) at each call, so wrapping it there
 * counts every one. Files share a runtime (`isolate: false`): it is
 * wrapped once.
 */

/** How many imports started, and how many are still out. */
const calls = { started: 0, out: 0 };

/** Marks the runner's import as counted, so it is wrapped once. */
const counted = Symbol.for("grasp.background-calls");

const runnerOf = (): object | undefined => {
  const mocker: unknown = Reflect.get(globalThis, "__vitest_mocker__");
  const runner: unknown =
    typeof mocker === "object" && mocker !== null
      ? Reflect.get(mocker, "moduleRunner")
      : undefined;
  return typeof runner === "object" && runner !== null ? runner : undefined;
};

/** Counts every import the pool's module runner makes from here on. */
export const countBackgroundCalls = (): void => {
  const runner = runnerOf();
  const original: unknown =
    runner === undefined ? undefined : Reflect.get(runner, "import");
  if (runner === undefined || typeof original !== "function") {
    throw new Error("Expected the test pool's module runner, with import");
  }
  if (Reflect.get(original, counted) === true) {
    return;
  }
  const wrapped = async (specifier: string): Promise<unknown> => {
    calls.started += 1;
    calls.out += 1;
    try {
      const imported: unknown = await Reflect.apply(original, runner, [
        specifier,
      ]);
      return imported;
    } finally {
      calls.out -= 1;
    }
  };
  Reflect.set(wrapped, counted, true);
  Reflect.set(runner, "import", wrapped);
};

/**
 * How many rounds of {@link quietMs} a file waits at most for its
 * background calls to go quiet: about 5 seconds, within a hook's 10. A
 * call out longer than that would be a bug of its own.
 */
const quietRounds = 25;

/**
 * How long no call may start or be out for the file's background work to
 * count as quiet: a run a test left going takes its next step within it.
 */
const quietMs = 200;

/**
 * Waits until no call is out and none started for {@link quietMs}, at
 * most {@link quietRounds} rounds. On `scheduler.wait`, which a test's
 * fake timers leave alone.
 */
export const backgroundCallsQuiet = async (): Promise<void> => {
  for (let round = 0; round < quietRounds; round += 1) {
    const { started } = calls;
    // Rounds one after another: each looks at what the last one left.
    // oxlint-disable-next-line no-await-in-loop
    await scheduler.wait(quietMs);
    if (calls.out === 0 && calls.started === started) {
      return;
    }
  }
};
