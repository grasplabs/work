import type { Identity } from "@grasp-os/shared/rpc";
import * as stylex from "@stylexjs/stylex";

import { IntegrationItem } from "./integration-item.tsx";
import type { Integration } from "./integrations.ts";
import type { ConnectionUses } from "./workflows-using.tsx";

// One app in a list of its own `<ul>`, as an App's settings list the apps
// it uses: the Integrations page's row (integration-item.tsx, on Grasp
// UI's Item), in a list item of its own, since an Item outside an
// ItemGroup is drawn as a plain row. Its mark, its name to open it, what
// kind of app it is and which workflows use it, where it stands, and the
// one thing this person can do about it now.

const styles = stylex.create({
  row: { minWidth: 0, listStyle: "none" },
});

/** One app, as a list item: what it is, where it stands, and what this person can do about it. */
export const IntegrationRow = ({
  integration,
  identity,
  uses,
}: {
  integration: Integration;
  identity: Identity;
  /** Which workflows use each connection; left out where the page doesn't say. */
  uses?: ConnectionUses;
}) => (
  <li {...stylex.props(styles.row)}>
    <IntegrationItem
      identity={identity}
      integration={integration}
      {...(uses === undefined ? {} : { uses })}
    />
  </li>
);
