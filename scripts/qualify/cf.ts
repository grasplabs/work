/**
 * Cloudflare as the real-account qualification (run.ts) reaches it:
 * through the `cf` CLI alone, signed in with its own login (OAuth), on
 * the account `CLOUDFLARE_ACCOUNT_ID` names. A token in the environment is
 * removed before cf runs, so cf never acts as anything but its login.
 *
 * Every invocation is recorded in the run's evidence (its arguments, which
 * hold names and ids only, whether it succeeded, and cf's last error line;
 * never its output or a secret), and every write is refused unless every
 * resource it names is the run's own (its prefix, or an id it created),
 * so a run can't touch anything else in the account, whatever the login
 * allows. Without `live`, a write isn't run at all: it's recorded as
 * planned.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/** One line of the run's evidence. */
export type Evidence = Record<string, unknown> & { kind: string };

/** Appends to the evidence file, one JSON line each, with the time. */
export const evidenceLog =
  (file: string) =>
  (entry: Evidence): void => {
    appendFileSync(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      { mode: 0o600 }
    );
  };

/** The last non-empty lines of `output`, for an error or the evidence. */
export const lastLines = (output: string): string => {
  const lines = output
    .split("\n")
    .map((line) => line.replace(/^[│┌└◆├]\s*/u, "").trim())
    .filter((line) => line !== "");
  // Cloudflare's own code and message first, where cf printed one.
  const coded = lines.filter((line) => /\[\d{4,5}\]/u.test(line));
  return [...coded, ...lines.slice(-2)].join(" | ");
};

/** A cf invocation that failed: its command and what cf said. */
export class CfError extends Error {
  readonly output: string;

  constructor(command: string, output: string) {
    super(`cf ${command} failed: ${lastLines(output)}`);
    this.name = "CfError";
    this.output = output;
  }
}

/** A placed client's resource, named after its deployment by provisioning. */
const clientResource = /^g[a-z0-9]+-grasp-os-/u;

/**
 * Whether `name` is one a run expects in Grasp's account: a qualification
 * run's, the platform's own, or a placed client's. Only ever read: the
 * run writes nothing but its own (`ownsAll`).
 */
export const knownName = (name: string): boolean =>
  name.startsWith("qual-") ||
  name.startsWith("grasp-os-") ||
  clientResource.test(name);

/**
 * Whether `name` is the run's own by its name: the prefix itself, or a
 * name under it (`<prefix>-…`). Never one that merely starts the same,
 * which another run's prefix could (`qual-2026` and `qual-20261028`).
 */
export const isOwnName = (name: string, prefix: string): boolean =>
  name === prefix || name.startsWith(`${prefix}-`);

/** A name or id as the run makes them: nothing a path or flag could hide. */
const plainName = /^[A-Za-z0-9_-]+$/u;

/**
 * Whether every resource a write names is the run's: a plain name that
 * starts with its prefix, or an id it created; and it names one at least.
 */
export const ownsAll = (
  names: readonly string[],
  prefix: string,
  created: ReadonlySet<string>
): boolean =>
  names.length > 0 &&
  names.every(
    (name) =>
      plainName.test(name) && (isOwnName(name, prefix) || created.has(name))
  );

export interface CfOptions {
  accountId: string;
  /** What every resource the run writes is named after: `qual-<date>`. */
  prefix: string;
  live: boolean;
  record: (entry: Evidence) => void;
  /** The cf executable; `cf` on the PATH by default. */
  bin?: string;
}

export interface Write {
  /** Every resource the write acts on: each must be the run's. */
  names: readonly string[];
  /** The directory cf runs in (a project's, for `cf deploy`). */
  cwd?: string;
}

/** The environment cf runs with: the account, and never a token. */
const cfEnvironment = (accountId: string): NodeJS.ProcessEnv => {
  const {
    CLOUDFLARE_API_TOKEN: _token,
    CLOUDFLARE_API_KEY: _key,
    CLOUDFLARE_EMAIL: _email,
    ...rest
  } = process.env;
  return { ...rest, CLOUDFLARE_ACCOUNT_ID: accountId };
};

/**
 * cf's JSON result: an array for a list, an object otherwise. Anything
 * else (nothing, or cf's help, which it prints with success for an option
 * it won't take) is a failure, never an empty answer: a listing that
 * reads as empty would let preflight pass an account it didn't read.
 */
const parsed = (command: string, output: string): unknown => {
  try {
    const value: unknown = JSON.parse(output.trim());
    if (typeof value === "object" && value !== null) {
      return value;
    }
  } catch {
    // Not JSON: refused below.
  }
  throw new CfError(
    command,
    `cf printed no JSON result: ${output.slice(0, 200)}`
  );
};

/** The run's cf: `read` for a command that changes nothing, `write` for one that does. */
export const cfCli = (options: CfOptions) => {
  const { accountId, prefix, live, record } = options;
  const bin = options.bin ?? "cf";
  const created = new Set<string>();

  /**
   * Runs cf: its result (standard output), and what it reported on the way
   * (standard error: a deploy's URLs, a refusal's reason).
   */
  const run = (
    args: readonly string[],
    cwd?: string
  ): { stdout: string; stderr: string } => {
    const command = args.join(" ");
    const ran = spawnSync(bin, args, {
      cwd,
      env: cfEnvironment(accountId),
      encoding: "utf-8",
      // Never a terminal: cf asks nothing and prints only its result.
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const stdout = ran.stdout ?? "";
    const stderr = ran.stderr ?? "";
    if (ran.status !== 0) {
      const output = `${stderr}${stdout}${ran.error === undefined ? "" : String(ran.error)}`;
      record({ kind: "cf", command, ok: false, error: lastLines(output) });
      throw new CfError(command, output);
    }
    record({ kind: "cf", command, ok: true });
    return { stdout, stderr };
  };

  return {
    read: (args: readonly string[]): unknown =>
      parsed(args.join(" "), run(args).stdout),
    /**
     * Runs a write, or without `live` its `--dry-run`, after checking it
     * names only the run's own resources. Answers cf's result, and
     * whether it was only planned.
     */
    write: (
      args: readonly string[],
      { names, cwd }: Write
    ): { planned: boolean; result: unknown; output: string } => {
      if (!ownsAll(names, prefix, created)) {
        record({ kind: "refused", command: args.join(" "), names });
        throw new Error(
          `Refused: cf ${args.join(" ")} names something not of run ${prefix}`
        );
      }
      // A dry run runs no write at all: nothing rests on cf honouring
      // its own --dry-run.
      if (!live) {
        record({ kind: "planned", command: args.join(" ") });
        return { planned: true, result: null, output: "" };
      }
      const { stdout, stderr } = run(args, cwd);
      // A deploy reports its URLs on standard error, with its progress.
      const output = `${stdout}\n${stderr}`;
      // `cf deploy` prints progress, not JSON: its output is kept as text.
      // A change that answers no data prints nothing.
      const json = args[0] !== "deploy" && stdout.trim() !== "";
      return {
        planned: false,
        result: json ? parsed(args.join(" "), stdout) : null,
        output,
      };
    },
    /** Marks `id` as the run's own, so later writes may name it. */
    own: (id: string): void => {
      created.add(id);
    },
  };
};

export type Cf = ReturnType<typeof cfCli>;

/** The entries of a cf list, whether it printed an array or an object holding one. */
export const entriesOf = (result: unknown, key?: string): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  if (typeof result === "object" && result !== null && key !== undefined) {
    const inner: unknown = Reflect.get(result, key);
    return Array.isArray(inner) ? inner : [];
  }
  return [];
};

/** The first of `keys` that `entry` has as a string. */
export const textField = (
  entry: unknown,
  keys: readonly string[]
): string | undefined => {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  for (const key of keys) {
    const value: unknown = Reflect.get(entry, key);
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
};
