import type { ProjectConnections as Connections } from "@grasp-os/shared/projects";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

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

// A project's connections: never put in by hand, only read from what its
// Apps and workflows use (core's `projects.connections`). Each is named
// where the person may see it in Integrations; the rest are only counted.

/** The connections a project's Apps and workflows use, and how many more. */
export const ProjectConnectionList = ({
  connections: { connections, unseen },
}: {
  connections: Connections;
}) => {
  const { t } = useLingui();
  return (
    <>
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
    </>
  );
};
