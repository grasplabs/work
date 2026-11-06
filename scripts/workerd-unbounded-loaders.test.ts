/**
 * On plain workerd, where no sandbox bounds them and the deployment hasn't
 * set `SANDBOX_IN_PROCESS=unbounded`, core refuses what would run App code
 * in process (apps/core/test/workerd/unbounded-worker.ts):
 * a bound `SANDBOX_HOST` doesn't allow them, as nothing runs them there.
 * An independent JSON workflow's run and its calculations, the page
 * compiler and the package builder run on the sandbox host where one is
 * bound, and are refused where none is. Gone with App workflows: an App
 * workflow's metadata, tests and dry runs, read by loading its code.
 */
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { serveStandIn } from "./workerd-stand-in.ts";
import { cleanUp, tempDir } from "./workerd-test-server.ts";

describe("App code no sandbox bounds, on plain workerd", () => {
  let coreUrl: string;

  beforeAll(async () => {
    // Bound, as on-prem binds it, to a supervisor that isn't there: nothing
    // here may reach it.
    coreUrl = await serveStandIn(
      "unbounded-worker.ts",
      path.join(tempDir(), "no-supervisor.sock")
    );
  }, 120_000);

  afterAll(() => {
    cleanUp();
  });

  const refusal = async (what: string): Promise<string> => {
    const response = await fetch(`${coreUrl}${what}`);
    return await response.text();
  };

  it("refuses to load a JSON workflow's run where no sandbox host is bound", async () => {
    const refused = await refusal("run");
    expect(refused).toContain("SandboxUnavailableError");
    expect(refused).toContain("No sandbox bounds App code here");
  });

  it("refuses to run a JSON workflow's calculation where no sandbox host is bound", async () => {
    const refused = await refusal("compute");
    expect(refused).toContain("SandboxUnavailableError");
    expect(refused).toContain("No sandbox bounds App code here");
  });

  it("refuses to compile an App's pages where no sandbox host is bound", async () => {
    const refused = await refusal("pages");
    expect(refused).toContain("SandboxUnavailableError");
    expect(refused).toContain("No sandbox bounds App code here");
  });

  it("refuses to resolve or build an App's packages where no sandbox host is bound", async () => {
    const refused = [await refusal("resolve"), await refusal("build")];
    expect(refused).toStrictEqual([
      expect.stringContaining(
        "SandboxUnavailableError: No sandbox bounds App code here"
      ),
      expect.stringContaining(
        "SandboxUnavailableError: No sandbox bounds App code here"
      ),
    ]);
  });
});
