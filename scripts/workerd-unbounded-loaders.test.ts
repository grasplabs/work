/**
 * On plain workerd, where no sandbox bounds them and the deployment hasn't
 * set `SANDBOX_IN_PROCESS=unbounded`, core refuses to load a workflow's run
 * or an App's server object (apps/core/test/workerd/unbounded-worker.ts):
 * a bound `SANDBOX_HOST` doesn't allow them, as nothing runs them there.
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

  it("refuses to load a workflow's run", async () => {
    const refused = await refusal("run");
    expect(refused).toContain("SandboxUnavailableError");
    expect(refused).toContain(
      "A workflow's run runs App code that no sandbox bounds here yet"
    );
  });

  it("refuses to read a workflow's metadata", async () => {
    const refused = await refusal("metadata");
    expect(refused).toContain("SandboxUnavailableError");
    expect(refused).toContain(
      "A workflow's metadata runs App code that no sandbox bounds here yet"
    );
  });

  it("refuses to load a draft's preview", async () => {
    const refused = await refusal("preview");
    expect(refused).toContain("SandboxUnavailableError");
    expect(refused).toContain(
      "A draft's preview runs App code that no sandbox bounds here yet"
    );
  });

  it("refuses to load an App's server object, which a workflow's step calls", async () => {
    const refused = await refusal("app");
    expect(refused).toContain("SandboxUnavailableError");
    expect(refused).toContain(
      "An App's server object runs App code that no sandbox bounds here yet"
    );
  });
});
