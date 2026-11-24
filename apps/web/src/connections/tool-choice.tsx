import type { CatalogTool } from "@grasp-os/shared/connect";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Switch } from "@grasp-os/ui/components/switch";
import { EyeIcon, Icon, LockIcon, PencilIcon } from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { toolWords } from "./tool-choices.ts";
import type { AllowedTool } from "./tool-choices.ts";

/**
 * One tool of a toolkit, as a row of Damsko's Item: a switch to allow
 * it, and what it may do: Never while it is off, Read when it only reads,
 * Write when it changes things. An allowed tool's Read or Write is a
 * button that switches it between the two (tool-choices.ts). The switch's
 * label is the tool's name, said to a screen reader; the row's title shows
 * it.
 */
export const ToolChoice = ({
  tool,
  choice,
  onAllow,
  onRead,
  disabled = false,
  locked = false,
  app,
}: {
  tool: CatalogTool;
  /** The app's id in the catalog, which a Composio tool's name starts with. */
  app: string;
  choice: AllowedTool | undefined;
  onAllow: (allow: boolean) => void;
  onRead: (read: boolean) => void;
  /** While a change is under way, or for someone who may not change it. */
  disabled?: boolean;
  /** Its switch can't be turned off: the last tool allowed. */
  locked?: boolean;
}) => {
  const { t } = useLingui();
  const name = toolWords(tool.name, app);
  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        {tool.description === null ? null : (
          <ItemDescription>{tool.description}</ItemDescription>
        )}
      </ItemContent>
      <ItemActions>
        {choice === undefined ? (
          <Badge icon={LockIcon}>
            {t({ message: "Never", context: "what a tool may do" })}
          </Badge>
        ) : (
          <Button
            aria-label={
              choice.read
                ? t`${name} reads only. Change to Write`
                : t`${name} may write. Change to Read`
            }
            disabled={disabled}
            onClick={() => {
              onRead(!choice.read);
            }}
            size="xs"
            variant="ghost"
          >
            <Icon icon={choice.read ? EyeIcon : PencilIcon} />
            {choice.read
              ? t({ message: "Read", context: "what a tool may do" })
              : t({ message: "Write", context: "what a tool may do" })}
          </Button>
        )}
        <Field
          orientation="horizontal"
          disabled={disabled || (locked && choice !== undefined)}
        >
          <FieldLabel>
            <span {...stylex.props(visuallyHidden)}>{name}</span>
          </FieldLabel>
          <Switch checked={choice !== undefined} onCheckedChange={onAllow} />
        </Field>
      </ItemActions>
    </Item>
  );
};
