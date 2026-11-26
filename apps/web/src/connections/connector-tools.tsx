import type { ConnectorToolView, ToolClass } from "@grasp-os/shared/connect";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Switch } from "@grasp-os/ui/components/switch";
import { Text } from "@grasp-os/ui/components/text";
import { toast } from "@grasp-os/ui/components/toast";
import { useLingui } from "@lingui/react/macro";

import type { Loaded } from "../load-from-core.tsx";
import { PartNotLoaded } from "./part-not-loaded.tsx";
import { SectionCard } from "./section-card.tsx";
import { useChange } from "./use-change.ts";

// A connector made from a URL, as an admin sees its tools (GRA-2347): each
// by the name its server lists it under, what kind of tool it is by its
// class, the server's own description (its words, shown as text alone and
// cut to a line), and a switch that lets it through or blocks it. A
// blocked tool is offered to nobody and refused at the call; connect
// checks the role and audits the change, and the page is read again
// (`useChange`).

/** What kind of tool a class is, in plain words; null for a name no list holds now. */
const useKindOf = () => {
  const { t } = useLingui();
  return (toolClass: ToolClass | null): string => {
    switch (toolClass) {
      case "read-own":
      case "read-company":
      case "read-others": {
        return t`Reads`;
      }
      case "change-own":
      case "change-company": {
        return t`Changes`;
      }
      case "reach-others": {
        return t`Reaches other people`;
      }
      case "never": {
        return t`Grasp never runs it`;
      }
      case null: {
        return t`Not listed now`;
      }
      default: {
        return toolClass satisfies never;
      }
    }
  };
};

/** One tool: its name, its kind and description, and whether Grasp may use it. */
const ToolRow = ({
  connector,
  tool,
  busy,
  change,
}: {
  connector: string;
  tool: ConnectorToolView;
  busy: boolean;
  change: ReturnType<typeof useChange>["change"];
}) => {
  const { t } = useLingui();
  const kindOf = useKindOf();
  const { name } = tool;
  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        <ItemDescription>{kindOf(tool.class)}</ItemDescription>
        {tool.description === null ? null : (
          <Text as="span" color="muted" size="sm" truncate>
            {tool.description}
          </Text>
        )}
      </ItemContent>
      <ItemActions>
        <Switch
          aria-label={t`Let Grasp use ${name}`}
          checked={!tool.blocked}
          disabled={busy}
          onCheckedChange={(on) => {
            void change(
              async (session) => {
                await session.connections.blockConnectorTool({
                  connector,
                  tool: name,
                  blocked: !on,
                });
              },
              (reason) => {
                toast.error(reason);
              }
            );
          }}
        />
      </ItemActions>
    </Item>
  );
};

/** A connector's tools for an admin, each to block or let through; nothing for anyone else. */
export const ConnectorTools = ({
  connector,
  signInHost,
  tools,
}: {
  /** The connector's id. */
  connector: string;
  /** Where its people sign in (`CatalogEntry.signInHost`), seen as soon as it is added. */
  signInHost: string | undefined;
  /** The read of its tools; none for someone who isn't an admin. */
  tools: Loaded<ConnectorToolView[]> | undefined;
}) => {
  const { t } = useLingui();
  const { busy, change } = useChange();
  if (tools === undefined) {
    return null;
  }
  const title = t`Tools its server lists`;
  const host = signInHost;
  const signsInAt =
    host === undefined ? undefined : t`People sign in at ${host}.`;
  // Where people sign in shows even when its tools can't be read.
  if (tools.state !== "ready") {
    return (
      <>
        {signsInAt === undefined ? null : (
          <Text color="muted" size="sm">
            {signsInAt}
          </Text>
        )}
        <PartNotLoaded page={tools} what={title} />
      </>
    );
  }
  const blocking = t`Turn a tool off to block it: Grasp offers it to nobody and refuses every call to it.`;
  const description =
    signsInAt === undefined ? blocking : `${signsInAt} ${blocking}`;
  if (tools.data.length === 0) {
    return (
      <SectionCard description={description} title={title}>
        <Text color="muted" size="sm">
          {t`Its tools show here once someone connects it.`}
        </Text>
      </SectionCard>
    );
  }
  return (
    <SectionCard description={description} flush title={title}>
      <ItemGroup separated>
        {tools.data.map((tool) => (
          <ToolRow
            busy={busy}
            change={change}
            connector={connector}
            key={tool.name}
            tool={tool}
          />
        ))}
      </ItemGroup>
    </SectionCard>
  );
};
