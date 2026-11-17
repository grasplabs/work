import type { ProjectConnections as Connections } from "@grasp-os/shared/projects";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { Empty } from "../grasp/empty/index.ts";
import { Cable } from "../grasp/icons/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// A project's connections: never put in by hand, only read from what its
// Apps and workflows use (core's `projects.connections`). Each is named
// where the person may see it in Integrations; the rest are only counted.

const styles = stylex.create({
  tab: {
    display: "grid",
    gap: grasp.space3,
  },
});

/** The project's Connections tab: what its Apps and workflows use. */
export const ProjectConnections = ({
  connections: { connections, unseen },
}: {
  connections: Connections;
}) => {
  const { t } = useLingui();
  if (connections.length === 0 && unseen === 0) {
    return (
      <Empty size="inline">{t`Its apps and workflows use no connections.`}</Empty>
    );
  }
  return (
    <div {...stylex.props(styles.tab)}>
      {connections.length === 0 ? null : (
        <ItemGroup aria-label={t`Connections`} separated>
          {connections.map((connection) => (
            <Item key={connection.id} size="sm">
              <ItemMedia icon={Cable} iconLook="inline" />
              <ItemContent>
                <ItemTitle>{connection.provider}</ItemTitle>
                {connection.accountName === null ? null : (
                  <ItemDescription>{connection.accountName}</ItemDescription>
                )}
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
      {unseen === 0 ? null : (
        <Text size="xs" tone="muted">
          {plural(unseen, {
            one: "# more that you can't see",
            other: "# more that you can't see",
          })}
        </Text>
      )}
    </div>
  );
};
