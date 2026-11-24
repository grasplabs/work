/**
 * Linted by scripts/lint/no-inline-styles.test.ts with the repository's own
 * config: a `.js` path names a `.ts` or `.tsx` module, as TypeScript reads
 * it, and is followed there. The refusal carries a disable comment, which
 * fails if unused.
 */
import * as stylex from "@stylexjs/stylex";

import { Button } from "./kit-pass.js";
import { Panel } from "./own-panel.js";

const layout = stylex.create({ wide: { flexGrow: 1 } });

export const JsPath = () => (
  <>
    <Panel style={layout.wide} />
    {/* oxlint-disable-next-line grasp/no-inline-styles -- the kit's Button, by a `.js` path to a `.ts` module that passes it on */}
    <Button style={layout.wide} />
  </>
);
