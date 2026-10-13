/**
 * On plain workerd, where no sandbox bounds them and the deployment hasn't
<<<<<<< HEAD
 * set `SANDBOX_IN_PROCESS=unbounded`, core refuses to load a workflow's run
 * or an App's server object, or to start the screen compiler or the
 * package builder (apps/core/test/workerd/unbounded-worker.ts):
=======
 * set `SANDBOX_IN_PROCESS=unbounded`, core refuses to load an App's server
 * object or a draft's preview (apps/core/test/workerd/unbounded-worker.ts):
>>>>>>> d1e0aeb3b (feat(core): run a workflow's loads in a sandbox session on-prem)
 * a bound `SANDBOX_HOST` doesn't allow them, as nothing runs them there.
 * A workflow's code (its runs, metadata, tests and dry runs) runs on the
 * sandbox host where one is bound, and is refused where none is.
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

  it("refuses to load a workflow's run where no sandbox host is bound", async () => {
    const refused = await refusal("run");
    expect(refused).toContain("SandboxUnavailableError");
    expect(refused).toContain("No sandbox bounds App code here");
  });

  it("refuses to read a workflow's metadata where no sandbox host is bound", async () => {
    const refused = await refusal("metadata");
    expect(refused).toContain("SandboxUnavailableError");
    expect(refused).toContain("No sandbox bounds App code here");
  });

  it("refuses to run a workflow's tests where no sandbox host is bound", async () => {
    const refused = await refusal("tests");
    expect(refused).toContain("SandboxUnavailableError");
    expect(refused).toContain("No sandbox bounds App code here");
  });

  it("refuses to dry-run a workflow's tests where no sandbox host is bound", async () => {
    const refused = await refusal("dry-run");
    expect(refused).toContain("SandboxUnavailableError");
    expect(refused).toContain("No sandbox bounds App code here");
  });

  it("refuses to load a draft's preview", async () => {
    const refused = await refusal("preview");
    expect(refused).toContain("SandboxUnavailableError");
    expect(refused).toContain("No sandbox bounds a draft's preview here yet");
  });

  it("refuses to compile an App's screens", async () => {
    const refused = await refusal("screens");
    expect(refused).toContain("SandboxUnavailableError");
    expect(refused).toContain("No sandbox bounds the screen compiler here yet");
  });

  it("refuses to resolve or build an App's packages", async () => {
    const refused = [await refusal("resolve"), await refusal("build")];
    expect(refused).toStrictEqual([
      expect.stringContaining(
        "SandboxUnavailableError: No sandbox bounds the package builder here yet"
      ),
      expect.stringContaining(
        "SandboxUnavailableError: No sandbox bounds the package builder here yet"
      ),
    ]);
  });

  it("refuses to load an App's server object, which a workflow's step calls", async () => {
    const refused = await refusal("app");
    expect(refused).toContain("SandboxUnavailableError");
    expect(refused).toContain(
      "No sandbox bounds an App's server object here yet"
    );
  });
});
