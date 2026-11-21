import type { CatalogTool } from "@grasp-os/shared/connect";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import { visuallyHidden } from "../grasp/hidden/hidden.ts";
import { Edit, Lock, Show } from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "../grasp/item/index.ts";
import { Switch } from "../grasp/switch/index.ts";
import { toolWords } from "./tool-choices.ts";
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
