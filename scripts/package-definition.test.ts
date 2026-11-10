import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { definitionPackageFormatVersion } from "@grasp-os/shared/definition-packages";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { parse } from "yaml";
import { z } from "zod";

import { steeringCases } from "../apps/core/test/steering-cases.ts";
import { oxcWasmPin } from "../packages/compiler/oxc-wasm/wasm.ts";
import {
  ROOT,
  notesFiles,
  definitionOf,
  lockedIntegrity,
  locked,
  lockOf,
  made,
  scratch,
  packaged,
  refusalOf,
  packageJsonSchema,
  exactOrPrerelease,
  sha512,
  kitIntegrity,
  lockfileOf,
  metFor,
  installIn,
  platformChecker,
  platformParser,
  projectCheck,
  run,
} from "./package-definition-fixtures.ts";
import { PackagingError, readCatalog } from "./package-definition-lib.ts";
import { projectLockfile } from "./package-definition-lockfile.ts";

// Packaging a definition package into a standalone project
// (package-definition-lib.ts). The package is the SDK's Notes fixture, an
// App as the product lays it out, and a workflow generated as a version
// seals it; the project is checked as written, and every refusal leaves
// nothing behind.
//
// The installs and the tidy check, many seconds each, are
// package-definition-install, -locked-install and -tidy.test.ts, so they
// run on different workers and shards; what they share is
// package-definition-fixtures.ts.

/** The Notes App depending on `date-kit`, with `lock` as its lock. */
const withLock = (lock: string) =>
  definitionOf({
    ...notesFiles(),
    "package.json": JSON.stringify({
      dependencies: { "date-kit": "^1.2.0" },
    }),
    "grasp.lock.json": lock,
  });

/** The Notes App depending on whatever `lock` locks directly, at any version. */
const withAnyOfLock = (lock: string) =>
  definitionOf({
    ...notesFiles(),
    "package.json": JSON.stringify({
      dependencies: Object.fromEntries(
        Object.keys(
          z
            .object({ direct: z.record(z.string(), z.string()) })
            .parse(JSON.parse(lock)).direct
        ).map((name) => [name, "*"])
      ),
    }),
    "grasp.lock.json": lock,
  });

describe(
  "packaging a definition as a standalone project",
  { timeout: 60_000 },
  () => {
    afterEach(() => {
      for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
      vi.unstubAllGlobals();
    }, 60_000);

    it("writes the App with its references generated anew, the workflow, the vendored kit and notices, pinned exactly and offline", async () => {
      const fetches = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetches);
      const { out } = scratch();
      const definition = definitionOf();
      const written = await packaged(definition, out);
      const read = (file: string) =>
        readFileSync(path.join(out, file), "utf-8");

      const root = packageJsonSchema.parse(JSON.parse(read("package.json")));
      const vendored = ["brain", "sdk", "ui", "shared"].map((name) =>
        packageJsonSchema
          .pick({ dependencies: true })
          .parse(JSON.parse(read(`vendor/@grasp-os/${name}/package.json`)))
      );
      const versions = [
        ...Object.entries(root.dependencies),
        ...Object.entries(root.devDependencies),
        ...vendored.flatMap(({ dependencies }) => Object.entries(dependencies)),
      ].filter(([, version]) => !version.startsWith("link:"));
      const lockfile = lockfileOf(out);
      const lockedKeys = Object.keys(lockfile.packages);
      const notices = read("THIRD-PARTY-NOTICES.md");

      expect({
        app: written.filter((file) => file.startsWith("app/")),
        workflow: written.filter((file) => file.startsWith("workflows/")),
        vendorTests: written.filter(
          (file) => file.startsWith("vendor/") && /\.test|\/test\//u.test(file)
        ),
        sameSource:
          read("app/grasp.config.ts") === notesFiles()["grasp.config.ts"],
        sealedContracts: read("app/server/_generated/api.ts").includes(
          "notes.archive.confirmed"
        ),
        localIdentity:
          read("app/server/_generated/api.ts").includes('"local"') &&
          !read("app/server/_generated/api.ts").includes("app_0000"),
        grasp: Object.keys(root.dependencies).filter((name) =>
          name.startsWith("@grasp-os/")
        ),
        // An exact version, a prerelease's included, never a range.
        notExact: versions.filter(
          ([, version]) => !exactOrPrerelease.test(version)
        ),
        unnoticed: versions
          .map(([name]) => name)
          .filter((name) => !notices.includes(`| ${name} |`)),
        licence:
          read("LICENSES/AGPL-3.0-only.txt") ===
          readFileSync(path.join(ROOT, "LICENSE"), "utf-8"),
        fetched: fetches.mock.calls.length,
        withoutIntegrity: Object.entries(lockfile.packages)
          .filter(([, entry]) => !sha512.test(entry.resolution.integrity))
          .map(([key]) => key),
        notExactlyLocked: lockedKeys.filter(
          (key) => !exactOrPrerelease.test(key.slice(key.lastIndexOf("@") + 1))
        ),
        unlocked: versions
          .map(([name, version]) => `${name}@${version}`)
          .filter((key) => !lockedKeys.includes(key)),
        importers: Object.keys(lockfile.importers).toSorted(),
      }).toStrictEqual({
        app: [
          "app/.grasp/contracts.json",
          "app/grasp.config.ts",
          "app/server/_generated/api.ts",
          "app/server/_generated/dataModel.ts",
          "app/server/_generated/internal.ts",
          "app/server/_generated/server.ts",
          "app/server/confirmations.ts",
          "app/server/notes.ts",
          "app/server/schema.ts",
          // Its pages' route tree and root route, as the platform's build
          // gives them.
          "app/src/routeTree.gen.ts",
          "app/src/routes/__root.tsx",
          "app/src/routes/index.tsx",
          "app/tsconfig.pages.json",
          "app/tsconfig.server.json",
        ],
        workflow: [
          "workflows/greet/1.0.0/.grasp/workflow.ts",
          "workflows/greet/1.0.0/tsconfig.generated.json",
        ],
        vendorTests: [],
        sameSource: true,
        sealedContracts: true,
        localIdentity: true,
        grasp: [
          "@grasp-os/brain",
          "@grasp-os/shared",
          "@grasp-os/sdk",
          "@grasp-os/ui",
        ],
        notExact: [],
        unnoticed: [],
        licence: true,
        fetched: 0,
        withoutIntegrity: [],
        notExactlyLocked: [],
        unlocked: [],
        importers: [
          ".",
          "vendor/@grasp-os/brain",
          "vendor/@grasp-os/sdk",
          "vendor/@grasp-os/shared",
          "vendor/@grasp-os/ui",
        ],
      });
    });

    it("type-checks as the platform does: what it accepts passes, with the platform's checker, and what it refuses fails", async () => {
      const { out } = scratch();
      await packaged(definitionOf(), out);
      const install = await installIn(out, ["--frozen-lockfile", "--offline"]);
      const project = packageJsonSchema.parse(
        JSON.parse(readFileSync(path.join(out, "package.json"), "utf-8"))
      );
      // What the platform accepts, read as its parser reads it: a regular
      // expression holding `//` after a `)`, and a `///` comment of prose.
      const valid: Record<string, string> = {
        "app/server/pattern.ts":
          "export const check = (text: string): void => {\n  if (text) /[//] @ts-ignore/u.test(text);\n};\n",
        "app/src/components/prose.tsx":
          "/// The notes page.\n/// <summary>Notes</summary>\nexport const notes = 1;\n",
        // A declaration file read as declarations, as the platform reads it.
        "app/declared.d.ts":
          "export const limit: number;\nexport type Limit = typeof limit;\n",
      };
      const write = (files: Record<string, string>): void => {
        for (const [file, source] of Object.entries(files)) {
          mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
          writeFileSync(path.join(out, file), source);
        }
      };
      write(valid);
      const accepted = projectCheck(out);
      for (const file of Object.keys(valid)) {
        rmSync(path.join(out, file));
      }
      const held = {
        lint: run(out, "lint").status,
        format: run(out, "format:check").status,
      };

      // What the platform's check refuses, each in a file of its own: a
      // type error in a page and in server code; server code reaching the
      // DOM, which its isolate lacks; and server code importing what its
      // kind may not.
      const mistyped: Record<string, string> = {
        "app/src/components/typo.tsx": 'export const count: number = "none";\n',
        "app/server/typo.ts":
          "export const half = (value: number): string => value / 2;\n",
        "app/server/document.ts":
          "export const title = (): string => document.title;\n",
        "app/server/kit.ts":
          'import { Button } from "@grasp-os/ui/components/button";\n\nexport const button = Button;\n',
        // A directive below the top of a page, which TypeScript ignores
        // but the platform refuses wherever it stands.
        "app/src/components/late.tsx":
          'export const late = 1;\n/// <reference types="node" />\n',
      };
      // And what its build refuses before any check: every way a file
      // could steer the check, in server code and pages alike.
      const steering: Record<string, string> = {
        // Globals a page declares, which the platform refuses in every
        // kind of App code; and server code the parser refuses, or that
        // names a missing file, each refused once.
        "app/src/components/globals.tsx":
          "export {};\ndeclare global {\n  interface Window {\n    leak: number;\n  }\n}\n",
        "app/server/unparsed.ts": "export const = ;\n",
        "app/server/reference.ts":
          '/// <reference path="./missing.ts" />\nexport const one = 1;\n',
        // A suppression after a division by a non-null value, never a
        // regular expression.
        "app/server/non-null.ts":
          "const x: number | undefined = 1;\nexport const y = x! / 2; // @ts-ignore\nexport const b: string = 1;\n",
        "app/server/ambient.ts":
          "export {};\ndeclare global {\n  var document: { title: string };\n}\n",
        "app/server/dom.ts":
          '/// <reference lib="dom" />\nexport const title = (): string => document.title;\n',
        ...Object.fromEntries(
          steeringCases("@grasp-os/sdk/server").map(([, source], index) => [
            `app/server/steering-${index}.ts`,
            source,
          ])
        ),
      };
      write(mistyped);
      const failedCheck = projectCheck(out);
      for (const file of Object.keys(mistyped)) {
        rmSync(path.join(out, file));
      }
      // The App's own declarations are checked, as the platform checks
      // them: only the packages' are another's to check.
      write({ "app/declared.d.ts": "export type Count = Missing;\n" });
      const declared = projectCheck(out);
      rmSync(path.join(out, "app/declared.d.ts"));
      write(steering);
      const failedBuild = projectCheck(out);
      const codesOf = (file: string): string[] =>
        failedBuild.problems[file] ?? [];

      expect({
        install: install.status,
        checker: {
          tsrs: project.devDependencies["@tsrs/wasm"],
          // No TypeScript of its own: the check is tsrs's.
          typescript: project.devDependencies.typescript,
          // The parser it reads files with, as the platform's oxc does.
          parser: project.devDependencies["oxc-parser"],
        },
        // Its lint and format: the releases Grasp's isolate runs.
        tools: {
          oxlint: project.devDependencies.oxlint,
          oxfmt: project.devDependencies.oxfmt,
        },
        held,
        declared,
        accepted,
        failedCheck,
        failedBuild: {
          status: failedBuild.status,
          files: Object.keys(failedBuild.problems).toSorted(),
          notSteering: Object.entries(failedBuild.problems)
            .filter(([file]) => file !== "app/server/unparsed.ts")
            .flatMap(([, codes]) => codes)
            .filter((code) => code !== "steering"),
          shared: {
            unparsed: codesOf("app/server/unparsed.ts"),
            reference: codesOf("app/server/reference.ts"),
          },
        },
      }).toStrictEqual({
        install: 0,
        checker: {
          tsrs: platformChecker,
          typescript: undefined,
          parser: platformParser,
        },
        tools: { oxlint: oxcWasmPin.oxlint, oxfmt: oxcWasmPin.oxfmt },
        held: { lint: 0, format: 0 },
        declared: { status: 1, problems: { "app/declared.d.ts": ["TS2304"] } },
        accepted: { status: 0, problems: {} },
        failedCheck: {
          status: 1,
          problems: {
            "app/server/document.ts": ["TS2584"],
            "app/src/components/late.tsx": ["imports"],
            "app/src/components/typo.tsx": ["TS2322"],
            "app/server/kit.ts": ["TS2307"],
            "app/server/typo.ts": ["TS2322"],
          },
        },
        failedBuild: {
          status: 1,
          files: Object.keys(steering).toSorted(),
          notSteering: [],
          shared: { unparsed: ["compile"], reference: ["steering"] },
        },
      });
    });

    it("refuses a path that leaves its directory, collides once folded, a tool reads, or a file system can't hold, and writes nothing", async () => {
      const paths = [
        "../escape.ts",
        "server/../../escape.ts",
        "/etc/passwd",
        "C:/Windows/win.ini",
        "server\\notes.ts",
        "server//notes.ts",
        "./grasp.config.ts",
        "nul\0.ts",
        "GRASP.config.ts",
        "ſerver/notes.ts",
        "server/_generated/server.ts",
        "CON.ts",
        "server/lpt1",
        "notes.ts.",
        "notes.ts ",
        "tab\u0009.ts",
        ".git/config",
        "server/.GIT/hooks/pre-commit",
        ".npmrc",
        ".vscode/settings.json",
        // What a package manager run inside app/ would read or install into.
        "pnpm-workspace.yaml",
        "server/PNPM-LOCK.yaml",
        ".pnpmfile.cjs",
        ".pnpmfile.mjs",
        ".pnpmfile.js",
        "node_modules/left-pad/index.js",
        ".yarnrc",
        ".yarnrc.yml",
        "bunfig.toml",
        `${"a".repeat(256)}.ts`,
      ];
      const outcomes: Record<string, string> = {};
      for (const file of paths) {
        const { dir, out } = scratch();
        const definition = definitionOf({
          ...notesFiles(),
          [file]: "export {};\n",
        });
        // oxlint-disable-next-line no-await-in-loop -- one project at a time
        const outcome = await refusalOf(packaged(definition, out));
        outcomes[file] = `${outcome}, ${readdirSync(dir).length} written`;
      }
      expect(outcomes).toStrictEqual(
        Object.fromEntries(paths.map((file) => [file, "refused, 0 written"]))
      );
    });

    it("pins the App's locked packages and their dependencies exactly, and refuses a lock that would replace what the project pins", async () => {
      const { out } = scratch();
      await packaged(
        withLock(
          lockOf({ "date-kit": "1.2.0" }, [
            // A required peer is pinned among its dependencies, as its
            // lock resolved it.
            locked("date-kit", "1.2.0", "MIT | injected\n| row |", {
              "tz-data": "2.0.1",
              "tz-rules": "3.1.0",
            }),
            locked("tz-rules", "3.1.0", "MIT"),
            locked("tz-data", "2.0.1", "Apache-2.0"),
          ])
        ),
        out
      );
      const project = z
        .object({ dependencies: z.record(z.string(), z.string()) })
        .parse(
          JSON.parse(readFileSync(path.join(out, "package.json"), "utf-8"))
        );
      const lockfile = lockfileOf(out);
      const notices = readFileSync(
        path.join(out, "THIRD-PARTY-NOTICES.md"),
        "utf-8"
      );
      const zod = readCatalog(
        readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf-8")
      ).get("zod");
      const refused = await Promise.all(
        [
          lockOf({ "@grasp-os/sdk": "9.9.9" }, [
            locked("@grasp-os/sdk", "9.9.9", "MIT"),
          ]),
          lockOf({ react: "18.0.0" }, [locked("react", "18.0.0", "MIT")]),
          lockOf({ oxlint: "1.0.0" }, [locked("oxlint", "1.0.0", "MIT")]),
          lockOf({ "date-kit": "1.2.0" }, [
            locked("date-kit", "1.2.0", "MIT", { react: "18.0.0" }),
            locked("react", "18.0.0", "MIT"),
          ]),
          lockOf({ "date-kit": "1.2.0" }, [
            locked("date-kit", "1.2.0", "MIT", { "@grasp-os/shared": "1.0.0" }),
            locked("@grasp-os/shared", "1.0.0", "MIT"),
          ]),
          // The tarball the kit installs, with other dependencies.
          lockOf({ "date-kit": "1.2.0" }, [
            locked("date-kit", "1.2.0", "MIT", { zod: zod ?? "" }),
            {
              ...locked("zod", zod ?? "", "MIT", { "left-pad": "1.3.0" }),
              integrity: kitIntegrity(`zod@${zod ?? ""}`),
            },
            locked("left-pad", "1.3.0", "WTFPL"),
          ]),
          // The version of a package the kit installs, as another tarball.
          lockOf({ "date-kit": "1.2.0" }, [
            locked("date-kit", "1.2.0", "MIT", { zod: zod ?? "" }),
            locked("zod", zod ?? "", "MIT"),
          ]),
        ].map(
          async (lock) =>
            await refusalOf(packaged(withLock(lock), scratch().out))
        )
      );
      expect({
        dateKit: project.dependencies["date-kit"],
        locked: Object.fromEntries(
          ["date-kit@1.2.0", "tz-data@2.0.1", "tz-rules@3.1.0"].map((key) => [
            key,
            {
              integrity: lockfile.packages[key]?.resolution.integrity,
              dependencies: lockfile.snapshots[key]?.dependencies ?? {},
            },
          ])
        ),
        notices: notices
          .split("\n")
          .filter(
            (line) => line.startsWith("| date-kit") || line.includes("injected")
          ),
        refused,
      }).toStrictEqual({
        dateKit: "1.2.0",
        locked: {
          // Its dependencies, its required peer among them, as its lock
          // resolved them.
          "date-kit@1.2.0": {
            integrity: lockedIntegrity,
            dependencies: {
              "tz-data": "2.0.1",
              "tz-rules": "3.1.0",
            },
          },
          "tz-data@2.0.1": { integrity: lockedIntegrity, dependencies: {} },
          "tz-rules@3.1.0": { integrity: lockedIntegrity, dependencies: {} },
        },
        notices: ["| date-kit | 1.2.0 | unknown | the App's lock |"],
        refused: [
          "refused",
          "refused",
          "refused",
          "refused",
          "refused",
          "refused",
          "refused",
        ],
      });
    });

    it("refuses a package of another format by its format, saying how to recover", async () => {
      const current = definitionOf();
      const older = { ...current, formatVersion: 1 };
      let message = "packaged";
      try {
        await packaged(older, scratch().out);
      } catch (error) {
        message =
          error instanceof PackagingError ? error.message : String(error);
      }
      let newer = "packaged";
      try {
        await packaged(
          { ...current, formatVersion: definitionPackageFormatVersion + 1 },
          scratch().out
        );
      } catch (error) {
        newer = error instanceof PackagingError ? error.message : String(error);
      }
      expect({ message, newer }).toStrictEqual({
        message: `The package is format 1; this checkout reads format ${definitionPackageFormatVersion}. Export the App's definition again.`,
        newer: `The package is format ${definitionPackageFormatVersion + 1}; this checkout reads format ${definitionPackageFormatVersion}. Update this checkout to package it.`,
      });
    });

    it("meets the kit's peers only from the kit, never from an App's own versions", async () => {
      const lockfileFor = async (lock: string) => {
        const { out } = scratch();
        await packaged(withAnyOfLock(lock), out);
        return lockfileOf(out);
      };
      // An App's own versions of packages the kit's packages take as
      // optional peers: never what meets them, not another version, nor
      // the very one the checkout met a peer with outside the kit's graph.
      const kit = lockfileOf(
        await (async () => {
          const { out } = scratch();
          await packaged(definitionOf(), out);
          return out;
        })()
      );
      const withOwn = await lockfileFor(
        lockOf({ "date-fns": "3.0.0", "supports-color": "10.2.2" }, [
          locked("date-fns", "3.0.0", "MIT"),
          {
            ...locked("supports-color", "10.2.2", "MIT"),
            integrity: kitIntegrity("supports-color@10.2.2"),
          },
        ])
      );
      expect({
        dateFns: metFor(withOwn, "@base-ui/react", "date-fns"),
        supportsColor: metFor(withOwn, "debug", "supports-color"),
      }).toStrictEqual({
        dateFns: metFor(kit, "@base-ui/react", "date-fns"),
        supportsColor: metFor(kit, "debug", "supports-color"),
      });
    });

    it("renames the finished project onto an empty --out and leaves nothing beside it", async () => {
      const { dir, out } = scratch();
      mkdirSync(out);
      await packaged(definitionOf(), out);
      expect({
        beside: readdirSync(dir),
        written: readdirSync(out).toSorted(),
      }).toStrictEqual({
        beside: ["project"],
        written: [
          ".oxfmtrc.json",
          "LICENSES",
          "THIRD-PARTY-NOTICES.md",
          "app",
          "grasp",
          "grasp-project.json",
          "oxlint.config.ts",
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "tsconfig.json",
          "vendor",
          "workflows",
        ],
      });
    });

    it("refuses a directory that isn't empty, a key that isn't a workflow's, and dependencies with no lock", async () => {
      const used = scratch();
      writeFileSync(path.join(used.dir, "kept.txt"), "kept");
      const definition = definitionOf();
      const { greet } = {
        greet: definition.workflows["workspace/greet/1.0.0"],
      };
      expect({
        nonEmpty: await refusalOf(packaged(definition, used.dir)),
        kept: readFileSync(path.join(used.dir, "kept.txt"), "utf-8"),
        key: await refusalOf(
          packaged(
            {
              ...definition,
              workflows: { "workspace/../../escape/1.0.0": greet },
            },
            scratch().out
          )
        ),
        unlocked: await refusalOf(
          packaged(
            definitionOf({
              ...notesFiles(),
              "package.json": JSON.stringify({
                dependencies: { "left-pad": "^1.0.0" },
              }),
            }),
            scratch().out
          )
        ),
        notAPackage: await refusalOf(
          packaged(
            { formatVersion: definitionPackageFormatVersion },
            scratch().out
          )
        ),
      }).toStrictEqual({
        nonEmpty: "refused",
        kept: "kept",
        key: "refused",
        unlocked: "refused",
        notAPackage: "refused",
      });
    });
  }
);

describe("a packaged project's lockfile", () => {
  it("follows a checkout package's alias to the package it names, and keeps the alias", () => {
    const integrity = `sha512-${"A".repeat(86)}==`;
    const checkoutLock = [
      "lockfileVersion: '9.0'",
      "packages:",
      "  server@1.0.0:",
      `    resolution: {integrity: ${integrity}}`,
      "  h3@2.0.1-rc.20:",
      `    resolution: {integrity: ${integrity}}`,
      "snapshots:",
      "  server@1.0.0:",
      "    dependencies:",
      "      h3-v2: h3@2.0.1-rc.20",
      "  h3@2.0.1-rc.20: {}",
      "",
    ].join("\n");

    const written = z
      .object({
        packages: z.record(z.string(), z.unknown()),
        snapshots: z.record(
          z.string(),
          z.object({ dependencies: z.record(z.string(), z.string()) }).partial()
        ),
      })
      .parse(
        parse(
          projectLockfile({
            checkoutLock,
            importers: {
              ".": {
                dependencies: { server: "1.0.0" },
                devDependencies: {},
                peerDependencies: {},
              },
            },
            locks: [],
          })
        )
      );

    expect({
      packages: Object.keys(written.packages).toSorted(),
      server: written.snapshots["server@1.0.0"]?.dependencies,
    }).toStrictEqual({
      packages: ["h3@2.0.1-rc.20", "server@1.0.0"],
      server: { "h3-v2": "h3@2.0.1-rc.20" },
    });
  });
});
