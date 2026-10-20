/**
 * `vp run parity --prototype <dir>`: the designers' prototype next to
 * Grasp OS, page by page (GRA-493). It starts the prototype from a
 * checkout of grasplabs/prototype at the pinned commit (routes.ts), and
 * Grasp OS's local stack (`vp run dev`) with the prototype's demo company
 * seeded (`vp run seed`), unless one already runs; takes each page in
 * routes.ts at 1440 and 390 px, light and dark, in both apps; and writes a
 * side-by-side HTML report (report.ts) that a parity PR attaches.
 *
 * Options:
 *   --prototype <dir>   the prototype's checkout, its dependencies installed
 *                       (`pnpm install --filter "@grasp/app..."`); required
 *   --out <dir>         where the report goes; `parity-report/` by default
 *   --only <a,b>        only these pages, by their names in routes.ts
 *   --no-seed           take Grasp OS as it is, without seeding it first
 *
 * Nothing is installed or downloaded: the browser is the Chromium the
 * repo's Playwright end-to-end tests use, from Playwright's own cache. It
 * reaches only localhost, and signs in to Grasp OS through the local fake
 * IdP as the seed does, which only a local stack has (scripts/seed/local.ts).
 * What it started, it stops.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { z } from "zod";

import { localStaff } from "../../apps/core/test/sign-in-config.ts";
import { people } from "../seed/company.ts";
import {
  cookieHeader,
  origin as graspOrigin,
  signInAs,
} from "../seed/local.ts";
import { reportHtml } from "./report.ts";
import type { ReportPage, Shot, ShotPair } from "./report.ts";
import {
  parityRoutes,
  parityThemes,
  parityWidths,
  prototypeCommit,
} from "./routes.ts";
import type {
  ParityRoute,
  ParitySession,
  ParityTheme,
  ParityWidth,
} from "./routes.ts";

const root = path.join(import.meta.dirname, "../..");

/** Where the prototype's dev server is started, beside Grasp OS's 5173. */
const prototypePort = 5174;
const prototypeOrigin = `http://localhost:${prototypePort}`;

/** How long a dev server may take to answer, and the seed to finish. */
const startTimeoutMs = 300_000;

/** Each page's height, as a desktop's and a phone's window would be. */
const heightOf: Readonly<Record<ParityWidth, number>> = {
  1440: 900,
  390: 844,
};

/** How long a page gets to have its data and stop drawing loading states. */
const readyTimeoutMs = 20_000;

/** How long a page gets to settle once loaded: its data, fonts and motion. */
const settleMs = 1500;

const { values: args } = parseArgs({
  // A `--` before the options, as `vp run parity -- …` passes them, is no option.
  args: process.argv.slice(2).filter((arg, at) => at > 0 || arg !== "--"),
  options: {
    prototype: { type: "string" },
    out: { type: "string", default: "parity-report" },
    only: { type: "string" },
    "no-seed": { type: "boolean", default: false },
  },
});

if (args.prototype === undefined) {
  throw new Error(
    "--prototype <dir> is required: a checkout of grasplabs/prototype with its dependencies installed."
  );
}
const prototypeDir = path.resolve(args.prototype);

/** The pages asked for, by name, or every one. */
const routesAsked = (): readonly ParityRoute[] => {
  if (args.only === undefined) {
    return parityRoutes;
  }
  const names = new Set(args.only.split(",").map((name) => name.trim()));
  const unknown = [...names].filter(
    (name) => !parityRoutes.some((route) => route.name === name)
  );
  if (unknown.length > 0) {
    throw new Error(`No such page in routes.ts: ${unknown.join(", ")}`);
  }
  return parityRoutes.filter(({ name }) => names.has(name));
};

/** Refuses a checkout at another commit than the one compared against. */
const checkPrototype = (): string => {
  const head = execFileSync("git", ["-C", prototypeDir, "rev-parse", "HEAD"], {
    encoding: "utf-8",
  }).trim();
  if (!head.startsWith(prototypeCommit)) {
    throw new Error(
      `The prototype at ${prototypeDir} is at ${head.slice(0, 8)}, not ${prototypeCommit}: check that commit out first.`
    );
  }
  // Vite serves the files as they are on disk: a changed or added one would
  // be taken as the pinned commit's. What git ignores (node_modules) is fine.
  const changed = execFileSync(
    "git",
    ["-C", prototypeDir, "status", "--porcelain", "--untracked-files=all"],
    { encoding: "utf-8" }
  ).trim();
  if (changed !== "") {
    throw new Error(
      `The prototype at ${prototypeDir} has changes beyond ${prototypeCommit}: stash or remove them first.\n${changed}`
    );
  }
  return head;
};

/** Whether something answers at `url`. */
const answers = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
};

const pauseMs = 1000;

/** Waits until something answers at `url`, or throws after the timeout. */
const waitFor = async (url: string, what: string): Promise<void> => {
  const until = Date.now() + startTimeoutMs;
  while (Date.now() < until) {
    // oxlint-disable-next-line no-await-in-loop -- polled one at a time
    if (await answers(url)) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- polled one at a time
    await sleep(pauseMs);
  }
  throw new Error(`${what} didn't answer at ${url} in time.`);
};

const started: ChildProcess[] = [];

/** Starts `command` in a process group of its own, so stopping it stops what it started. */
const start = (command: string, commandArgs: string[], cwd: string): void => {
  started.push(
    spawn(command, commandArgs, { cwd, stdio: "inherit", detached: true })
  );
};

/** Stops every process group this started. */
const stopAll = (): void => {
  for (const { pid } of started) {
    if (pid !== undefined) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
};

/** The prototype's dev server, from its checkout. */
const startPrototype = async (): Promise<void> => {
  if (await answers(prototypeOrigin)) {
    throw new Error(
      `Something already answers at ${prototypeOrigin}: stop it, so the prototype taken is the checkout's.`
    );
  }
  start(
    "pnpm",
    ["exec", "vite", "--port", String(prototypePort), "--strictPort"],
    path.join(prototypeDir, "packages/grasp")
  );
  await waitFor(prototypeOrigin, "The prototype");
};

/** How long one sign-in may take, its requests aborted after. */
const signInTimeoutMs = 30_000;

/**
 * A session cookie in Grasp OS for `as`: the seed's admin, who sees every
 * page a company's people do, or the stack's Grasp staff member, through
 * Grasp's own tenant, for the pages only staff reach.
 */
const graspSession = async (
  as: ParitySession,
  signal = AbortSignal.timeout(signInTimeoutMs)
): Promise<string> => {
  if (as === "staff") {
    return await signInAs(localStaff, { providerId: "grasp-staff", signal });
  }
  const [admin] = people;
  if (admin === undefined) {
    throw new Error("The seed has no people.");
  }
  return await signInAs(admin.email, { signal });
};

/** Waits until the admin can sign in to Grasp OS, or throws after the timeout. */
const waitForSignIn = async (): Promise<void> => {
  const until = Date.now() + startTimeoutMs;
  for (;;) {
    const left = until - Date.now();
    try {
      // oxlint-disable-next-line no-await-in-loop -- tried one at a time
      await graspSession(
        "admin",
        AbortSignal.timeout(Math.max(1, Math.min(left, signInTimeoutMs)))
      );
      return;
    } catch (error) {
      if (Date.now() >= until) {
        throw error;
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- tried one at a time
    await sleep(pauseMs);
  }
};

/** A fresh random local secret, as the `.dev.vars` examples ask for one. */
const secret = (): string => randomBytes(32).toString("base64");

/**
 * The local secrets `vp run dev` needs (`.dev.vars`, as the examples beside
 * them say), made with fresh random values where a checkout has none: core
 * signs nobody in without them. Never committed (`.gitignore`); one that
 * exists is left as it is.
 */
const ensureDevVars = (): void => {
  const coreVars = path.join(root, "apps/core/.dev.vars");
  const connectVars = path.join(root, "apps/connect/.dev.vars");
  if (existsSync(coreVars) && existsSync(connectVars)) {
    return;
  }
  if (existsSync(coreVars) !== existsSync(connectVars)) {
    throw new Error(
      "Only one of apps/core/.dev.vars and apps/connect/.dev.vars exists: they share CAPABILITY_SIGNING_KEY, so make the other from it."
    );
  }
  const capability = secret();
  writeFileSync(
    coreVars,
    `ROUTER_SECRET=${secret()}\nBETTER_AUTH_SECRET=${secret()}\nCAPABILITY_SIGNING_KEY=${capability}\n`,
    { flag: "wx", mode: 0o600 }
  );
  writeFileSync(connectVars, `CAPABILITY_SIGNING_KEY=${capability}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    "Made apps/core/.dev.vars and apps/connect/.dev.vars with random local secrets.\n"
  );
};

/** Grasp OS's local stack, unless it runs already, seeded unless asked not to. */
const startGrasp = async (): Promise<void> => {
  if (!(await answers(graspOrigin))) {
    ensureDevVars();
    start(process.execPath, [path.join(root, "scripts/dev.ts")], root);
    await waitFor(graspOrigin, "Grasp OS");
  }
  // The frontend answers before core has its database: once someone can
  // sign in, core has it.
  await waitForSignIn();
  if (!args["no-seed"]) {
    // Adds only what is missing.
    const seeded = spawnSync(
      process.execPath,
      [path.join(root, "scripts/seed.ts")],
      { cwd: root, stdio: "inherit", timeout: startTimeoutMs }
    );
    if (seeded.status !== 0) {
      throw new Error("The seed failed: see its output above.");
    }
  }
};

/** One app's screenshot of `url`, written to `file` under `out`, or why not. */
const shotOf = async (
  browser: Browser,
  {
    url,
    width,
    theme,
    cookie,
    out,
    file,
  }: {
    url: string;
    width: ParityWidth;
    theme: ParityTheme;
    cookie: string | undefined;
    out: string;
    file: string;
  }
): Promise<Shot> => {
  const context = await browser.newContext({
    viewport: { width, height: heightOf[width] },
    colorScheme: theme,
    locale: "en-US",
    timezoneId: "Europe/Amsterdam",
    reducedMotion: "reduce",
  });
  try {
    if (cookie !== undefined) {
      const header = cookieHeader(cookie);
      const at = header.indexOf("=");
      await context.addCookies([
        {
          name: header.slice(0, at),
          value: header.slice(at + 1),
          // Chrome sends Secure cookies to http://localhost too; its cookie
          // store takes one only for a secure URL (e2e/people.ts).
          url: "https://localhost",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
    }
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "load" });
    if (response !== null && !response.ok()) {
      return { missing: `${url} answered ${response.status()}.` };
    }
    // Ready once its requests are done and nothing is still drawn as
    // loading (a skeleton, as both apps' kits mark it); bounded, so a page
    // that never gets there is said to be missing, not taken half drawn.
    await page
      .waitForLoadState("networkidle", { timeout: readyTimeoutMs })
      .catch(() => null);
    const ready = await page
      .waitForFunction(
        "!document.querySelector('[data-slot=\"skeleton\"]')",
        null,
        {
          timeout: readyTimeoutMs,
        }
      )
      .then(() => true)
      .catch(() => false);
    if (!ready) {
      return {
        missing: `${url} was still loading after ${String(readyTimeoutMs / 1000)} s.`,
      };
    }
    // An app that sends the page elsewhere (one only staff reach) took
    // another page: never labelled as this one.
    const landed = new URL(page.url());
    if (landed.pathname !== new URL(url).pathname) {
      return { missing: `${url} sent the page to ${landed.pathname}.` };
    }
    // In the page, where the DOM is: its fonts loaded before it's taken.
    await page.evaluate("document.fonts.ready.then(() => null)");
    await page.waitForTimeout(settleMs);
    const target = path.join(out, file);
    mkdirSync(path.dirname(target), { recursive: true });
    await page.screenshot({ path: target, animations: "disabled" });
    return { file };
  } catch (error) {
    return {
      missing: `${url} couldn't be taken: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await context.close();
  }
};

/** Every page asked, at every width and theme, in both apps. */
const takeAll = async (
  browser: Browser,
  out: string,
  cookies: Readonly<Record<ParitySession, string>>
): Promise<ReportPage[]> => {
  const pages: ReportPage[] = [];
  for (const route of routesAsked()) {
    const cookie = cookies[route.session ?? "admin"];
    const pairs: ShotPair[] = [];
    for (const width of parityWidths) {
      for (const theme of parityThemes) {
        const name = `${route.name}/${String(width)}-${theme}`;
        // One at a time: the local stack is one machine's.
        // oxlint-disable-next-line no-await-in-loop
        const prototype = await shotOf(browser, {
          url: `${prototypeOrigin}${route.prototype}`,
          width,
          theme,
          cookie: undefined,
          out,
          file: `${name}-prototype.png`,
        });
        // oxlint-disable-next-line no-await-in-loop
        const grasp = await shotOf(browser, {
          url: `${graspOrigin}${route.grasp}`,
          width,
          theme,
          cookie,
          out,
          file: `${name}-grasp.png`,
        });
        pairs.push({ width, theme, prototype, grasp });
      }
    }
    process.stdout.write(`Took ${route.name}.\n`);
    pages.push({
      name: route.name,
      prototypePath: route.prototype,
      graspPath: route.grasp,
      pairs,
    });
  }
  return pages;
};

/**
 * The file that marks a directory as one this tool wrote, listing the files
 * it wrote there: the only ones a later run deletes.
 */
const reportMarker = ".parity-report";

/** The files a report is made of, relative to its directory. */
const ownedFiles = (pages: readonly ReportPage[]): string[] => [
  "index.html",
  ...pages.flatMap(({ pairs }) =>
    pairs.flatMap(({ prototype, grasp }) =>
      [prototype, grasp].flatMap((shot) => ("file" in shot ? [shot.file] : []))
    )
  ),
];

/**
 * Removes the files an earlier report under `out` was made of, as its
 * marker lists them, and nothing else: notes or images put beside them
 * stay. A directory with files but no marker isn't a report: refused.
 */
const clearEarlierReport = (out: string): void => {
  const marker = path.join(out, reportMarker);
  if (!existsSync(marker)) {
    if (existsSync(out) && readdirSync(out).length > 0) {
      throw new Error(
        `--out ${out} holds files that aren't a parity report: refusing to touch them.`
      );
    }
    mkdirSync(out, { recursive: true });
    return;
  }
  let written: unknown;
  try {
    written = JSON.parse(readFileSync(marker, "utf-8"));
  } catch {
    // A marker of an older run, or unreadable: nothing listed to delete.
    written = [];
  }
  const read = z.array(z.string()).safeParse(written);
  const listed = read.success ? read.data : [];
  for (const file of listed) {
    const target = path.resolve(out, file);
    // Only a file of the report's own directory, however the list reads.
    if (target.startsWith(`${out}${path.sep}`)) {
      rmSync(target, { force: true });
    }
  }
  // Still this tool's directory, should this run stop before writing its own.
  writeFileSync(marker, "[]\n");
};

const main = async (): Promise<void> => {
  const commit = checkPrototype();
  const out = path.resolve(root, args.out);
  // Only an earlier report is ever deleted: never the checkout or what
  // holds it, nor a directory of anything else.
  const fromOut = path.relative(out, root);
  if (fromOut === "" || !fromOut.startsWith("..")) {
    throw new Error(
      `--out ${out} is the checkout or holds it: pick a directory of its own.`
    );
  }
  clearEarlierReport(out);
  try {
    await startPrototype();
    await startGrasp();
    const cookies = {
      admin: await graspSession("admin"),
      staff: await graspSession("staff"),
    };
    const browser = await chromium.launch();
    try {
      const pages = await takeAll(browser, out, cookies);
      writeFileSync(
        path.join(out, reportMarker),
        `${JSON.stringify(ownedFiles(pages), null, 2)}\n`
      );
      writeFileSync(
        path.join(out, "index.html"),
        reportHtml(pages, {
          commit: commit.slice(0, 8),
          takenAt: new Date().toISOString(),
        })
      );
      process.stdout.write(
        `Wrote ${path.relative(root, path.join(out, "index.html"))}.\n`
      );
    } finally {
      await browser.close();
    }
  } finally {
    stopAll();
  }
};

// Stopped by a signal, the `finally` in `main` doesn't run: the servers'
// process groups are stopped here instead.
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const) {
  process.on(signal, () => {
    stopAll();
    process.exit(code);
  });
}

await main();
