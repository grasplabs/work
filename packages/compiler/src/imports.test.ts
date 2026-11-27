import { describe, expect, it } from "vite-plus/test";

import { rewriteImports } from "./imports.ts";
import { kitModuleName, packageModuleName } from "./kit.ts";
import type { Kit } from "./kit.ts";

/** A kit that provides recharts, as the release's does (build.ts). */
const kit: Kit = {
  imports: ["react", "recharts"],
  icons: {},
  stylesheets: {},
  moduleCandidates: {},
  moduleImports: {},
  components: {},
  colors: [],
  previewModuleImports: {},
};

describe("a page's imports", () => {
  it("take recharts from the kit, where the kit's chart has it, even beside an approved copy", () => {
    const approvedCopy = packageModuleName("recharts", "a".repeat(64));
    const imported = { app: new Set<string>(), kit: new Set<string>() };

    const code = rewriteImports(
      'import { Bar } from "recharts";\nexport const Chart = Bar;\n',
      "src/routes/index.tsx",
      new Set([approvedCopy]),
      kit,
      imported
    );

    expect({
      code: code.includes(JSON.stringify(kitModuleName("recharts"))),
      kit: [...imported.kit],
      app: [...imported.app],
    }).toStrictEqual({
      code: true,
      kit: [kitModuleName("recharts")],
      app: [],
    });
  });
});
