import type { CatalogTool } from "@grasp-os/shared/connect";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { visuallyHidden } from "../grasp/hidden/hidden.ts";
import { Edit, Lock, Show } from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemTitle,
} from "../grasp/item/index.ts";
import { Switch } from "../grasp/switch/index.ts";
import type { AllowedTool } from "./tool-choices.ts";

/**
 * One tool of a toolkit, as a row of Grasp UI's Item: a switch to allow
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
}: {
  tool: CatalogTool;
  choice: AllowedTool | undefined;
  onAllow: (allow: boolean) => void;
  onRead: (read: boolean) => void;
  /** While a change is under way, or for someone who may not change it. */
  disabled?: boolean;
  /** Its switch can't be turned off: the last tool allowed. */
  locked?: boolean;
}) => {
  const { t } = useLingui();
  const { name } = tool;
  return (
    <Item size="xs">
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
      </ItemContent>
      <ItemActions>
        {choice === undefined ? (
          <Badge icon={Lock}>
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
            icon={choice.read ? Show : Edit}
            onClick={() => {
              onRead(!choice.read);
            }}
            size="xs"
            variant="ghost"
          >
            {choice.read
              ? t({ message: "Read", context: "what a tool may do" })
              : t({ message: "Write", context: "what a tool may do" })}
          </Button>
        )}
        <Switch
          checked={choice !== undefined}
          disabled={disabled || (locked && choice !== undefined)}
          label={<span {...stylex.props(visuallyHidden)}>{name}</span>}
          onCheckedChange={onAllow}
        />
      </ItemActions>
    </Item>
  );
};
