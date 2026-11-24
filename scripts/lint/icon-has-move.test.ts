import path from "node:path";

import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vite-plus/test";

import grasp from "./grasp-plugin.ts";

// grasp/icon-has-move as oxlint runs it, on imports of the frontend's own
// lucide-react, against a table of moves of its own (testdata).

// Its cases as Vitest's own: RuleTester takes them through its static
// `describe` and `it`.
Object.assign(RuleTester, { describe, it });

const tester = new RuleTester();

const table = "scripts/lint/testdata/icon-moves.css";
const options = [{ table }];

/** A file of the frontend's, where lucide-react resolves as the app's. */
const filename = path.join(
  import.meta.dirname,
  "../../apps/web/src/control.tsx"
);

/** `code`, let through. */
const moves = (name: string, code: string) => ({
  name,
  code,
  filename,
  options,
});

/**
 * Whether `value` is a rule as RuleTester takes it. The plugin is written
 * to oxlint's rule API, but its own types name only the parts of a node and
 * a context it reads, so they don't line up with oxlint's.
 */
const isRule = (value: unknown): value is Parameters<RuleTester["run"]>[1] =>
  typeof value === "object" && value !== null && "create" in value;

const rule = grasp.rules["icon-has-move"];
if (!isRule(rule)) {
  throw new Error("grasp/icon-has-move isn't a rule");
}

tester.run("grasp/icon-has-move", rule, {
  invalid: [
    {
      name: "an icon the table gives no move, though a rule names it",
      code: 'import { House } from "lucide-react";',
      filename,
      options,
      errors: [
        {
          messageId: "missing",
          data: { name: "House", icon: "house", table },
        },
      ],
    },
    {
      name: "an icon renamed as it is imported, by its own name",
      code: 'import { Pencil as Edit, Trash } from "lucide-react";',
      filename,
      options,
      errors: [
        {
          messageId: "missing",
          data: { name: "Pencil", icon: "pencil", table },
        },
      ],
    },
    {
      name: "a move of a part the icon isn't drawn with",
      code: 'import { Plus } from "lucide-react";',
      filename,
      options,
      errors: [
        {
          messageId: "beyond",
          data: { icon: "plus", parts: "2", part: "9", table },
        },
      ],
    },
    {
      name: "a move that makes the whole icon larger and smaller",
      code: 'import { Bell } from "lucide-react";',
      filename,
      options,
      errors: [{ messageId: "sized", data: { icon: "bell", table } }],
    },
  ],
  valid: [
    moves(
      "icons whose moves name parts they have, or the whole icon",
      'import { Check, Trash } from "lucide-react";'
    ),
    moves(
      "an icon imported as a type, which is never drawn",
      'import type { House } from "lucide-react"; import { type Pencil } from "lucide-react";'
    ),
    moves(
      "what lucide-react exports beside its icons",
      'import { createLucideIcon, LucideHouse } from "lucide-react";'
    ),
    moves("a name from another module", 'import { House } from "./house.tsx";'),
  ],
});
