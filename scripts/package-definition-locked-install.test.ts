import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  notesFiles,
  definitionOf,
  locked,
  lockOf,
  made,
  scratch,
  packaged,
  installIn,
} from "./package-definition-fixtures.ts";

// Packaging a definition package into a standalone project
// (package-definition-lib.ts). The package is the SDK's Notes fixture, an
// App as the product lays it out, and a workflow generated as a version
// seals it; the project is checked as written, and every refusal leaves
// nothing behind.
//
// Here, the install of an App's locked packages; the rest is
// package-definition.test.ts.

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

    it("installs an App's locked packages as its lock resolved them, and refuses one whose tarball isn't the one pinned", async () => {
      // The App's packages, as a registry of the test's own serves them.
      const tarballs = new Map<string, Buffer>();
      const tarball = (name: string, version: string, index: string) => {
        const dir = mkdtempSync(path.join(tmpdir(), "grasp-tarball-"));
        made.push(dir);
        mkdirSync(path.join(dir, "package"));
        writeFileSync(
          path.join(dir, "package/package.json"),
          JSON.stringify({ name, version, main: "index.js" })
        );
        writeFileSync(path.join(dir, "package/index.js"), index);
        spawnSync("tar", ["-czf", "package.tgz", "-C", dir, "package"], {
          cwd: dir,
        });
        const bytes = readFileSync(path.join(dir, "package.tgz"));
        tarballs.set(`/${name}/-/${name}-${version}.tgz`, bytes);
        return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
      };
      const lock = (dateKitIntegrity?: string) =>
        lockOf({ "date-kit": "1.2.0" }, [
          {
            ...locked("date-kit", "1.2.0", "MIT", {
              "tz-data": "2.0.1",
              "tz-rules": "3.1.0",
            }),
            integrity:
              dateKitIntegrity ??
              tarball(
                "date-kit",
                "1.2.0",
                'module.exports = [require("tz-data"), require("tz-rules")];\n'
              ),
          },
          {
            ...locked("tz-data", "2.0.1", "MIT"),
            integrity: tarball(
              "tz-data",
              "2.0.1",
              'module.exports = "tz-data";\n'
            ),
          },
          {
            ...locked("tz-rules", "3.1.0", "MIT"),
            integrity: tarball(
              "tz-rules",
              "3.1.0",
              'module.exports = "tz-rules";\n'
            ),
          },
        ]);
      const registry = createServer((request, response) => {
        const bytes = tarballs.get(request.url ?? "");
        if (bytes === undefined) {
          response.writeHead(404).end();
        } else {
          response.end(bytes);
        }
      });
      registry.listen(0, "127.0.0.1");
      await once(registry, "listening");
      const address = registry.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      const installed = async (appLock: string) => {
        const { out } = scratch();
        await packaged(
          definitionOf({
            ...notesFiles(),
            "package.json": JSON.stringify({
              dependencies: { "date-kit": "^1.2.0" },
            }),
            "grasp.lock.json": appLock,
          }),
          out
        );
        const install = await installIn(out, [
          "--frozen-lockfile",
          "--",
          `--registry=http://127.0.0.1:${port}/`,
          "--fetch-retries=0",
        ]);
        const loaded = spawnSync(
          process.execPath,
          ["-p", 'JSON.stringify(require("date-kit"))'],
          { cwd: out, encoding: "utf-8" }
        );
        return { install, loaded: loaded.stdout.trim() };
      };
      const accepted = await installed(lock());
      const tampered = await installed(
        lock(`sha512-${createHash("sha512").update("other").digest("base64")}`)
      );
      registry.close();
      expect({
        accepted: { status: accepted.install.status, loaded: accepted.loaded },
        tampered: {
          status: tampered.install.status === 0 ? "installed" : "refused",
          why: tampered.install.output.includes("ERR_PNPM_TARBALL_INTEGRITY"),
        },
      }).toStrictEqual({
        accepted: {
          status: 0,
          loaded: JSON.stringify(["tz-data", "tz-rules"]),
        },
        tampered: { status: "refused", why: true },
      });
    });
  }
);
