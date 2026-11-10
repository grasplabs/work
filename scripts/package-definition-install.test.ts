import { once } from "node:events";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  definitionOf,
  made,
  scratch,
  packaged,
  lockfileOf,
  installIn,
} from "./package-definition-fixtures.ts";

// Packaging a definition package into a standalone project
// (package-definition-lib.ts). The package is the SDK's Notes fixture, an
// App as the product lays it out, and a workflow generated as a version
// seals it; the project is checked as written, and every refusal leaves
// nothing behind.
//
// Here, the project's install from its lockfile alone, frozen and offline;
// the rest is package-definition.test.ts.

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

    it("installs from its lockfile alone, frozen and offline from what the checkout installed, and refuses a manifest that drifted from it", async () => {
      const { out } = scratch();
      await packaged(definitionOf(), out);
      const install = await installIn(out, ["--frozen-lockfile", "--offline"]);
      // A manifest that names what the lockfile doesn't is refused, not
      // resolved, by a plain install: the project's own settings freeze
      // its installs to its lockfile.
      const manifest = z
        .looseObject({ dependencies: z.record(z.string(), z.string()) })
        .parse(
          JSON.parse(readFileSync(path.join(out, "package.json"), "utf-8"))
        );
      writeFileSync(
        path.join(out, "package.json"),
        JSON.stringify({
          ...manifest,
          dependencies: { ...manifest.dependencies, "left-pad": "1.3.0" },
        })
      );
      const drifted = await installIn(out, ["--offline"]);
      expect({
        install: install.status,
        drifted: {
          status: drifted.status === 0 ? "installed" : "refused",
          why: drifted.output.includes("ERR_PNPM_OUTDATED_LOCKFILE"),
        },
      }).toStrictEqual({
        install: 0,
        drifted: { status: "refused", why: true },
      });
    });

    it("refuses at install a tarball other than the one its lockfile pins", async () => {
      const { out } = scratch();
      await packaged(definitionOf(), out);
      // The registry serves something else for one pinned package: here a
      // registry of the test's own, and a pin to a tarball it doesn't
      // have, so the install fetches it rather than reusing the store.
      const served: string[] = [];
      const registry = createServer((request, response) => {
        served.push(request.url ?? "");
        if (request.url?.endsWith(".tgz") === true) {
          response.end("not the pinned tarball");
        } else {
          response.writeHead(404).end();
        }
      });
      registry.listen(0, "127.0.0.1");
      await once(registry, "listening");
      const address = registry.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      const lockText = readFileSync(path.join(out, "pnpm-lock.yaml"), "utf-8");
      const zodKey = Object.keys(lockfileOf(out).packages).find((key) =>
        key.startsWith("zod@")
      );
      const tampered = lockText.replace(
        new RegExp(
          `("${zodKey}": \\{\\n\\s+"resolution": \\{\\n\\s+"integrity": ")[^"]+`,
          "u"
        ),
        `$1sha512-${"A".repeat(86)}==`
      );
      writeFileSync(path.join(out, "pnpm-lock.yaml"), tampered);
      const install = await installIn(out, [
        "--frozen-lockfile",
        "--",
        `--registry=http://127.0.0.1:${port}/`,
        "--fetch-retries=0",
      ]);
      registry.close();
      expect({
        tampered: tampered !== lockText,
        status: install.status === 0 ? "installed" : "refused",
        why: install.output.includes("ERR_PNPM_TARBALL_INTEGRITY"),
        fetched: served.filter((url) => url.endsWith(".tgz")),
      }).toStrictEqual({
        tampered: true,
        status: "refused",
        why: true,
        fetched: [`/zod/-/${zodKey?.replace("@", "-")}.tgz`],
      });
    });
  }
);
