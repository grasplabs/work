import type { CatalogTool } from "@grasp-os/shared/connect";
import { Badge } from "@grasp-os/ui/components/badge";
import { Switch } from "@grasp-os/ui/components/switch";
import { Trans, useLingui } from "@lingui/react/macro";
import { EyeIcon, LockIcon, PenLineIcon } from "lucide-react";

import type { AllowedTool } from "./tool-choices.ts";

/** A tool that is off: Grasp never calls it. */
const NeverBadge = () => (
  <Badge variant="outline">
    <LockIcon data-icon="inline-start" />
    <Trans context="what a tool may do">Never</Trans>
  </Badge>
);

/**
 * One tool of a toolkit, as the prototype's permission row: a switch to
 * allow it, and a badge with what it may do: Never while it is off, Read
 * when it only reads, Write when it changes things. An allowed tool's badge
 * is a button that switches it between Read and Write (tool-choices.ts).
 */
export const ToolChoice = ({
  tool,
  choice,
  onAllow,
  onRead,
  idPrefix = "connect-tool",
  disabled = false,
  locked = false,
}: {
  tool: CatalogTool;
  choice: AllowedTool | undefined;
  onAllow: (allow: boolean) => void;
  onRead: (read: boolean) => void;
  /** What its switch's ID starts with: one per list on a page. */
  idPrefix?: string;
  /** While a change is under way, or for someone who may not change it. */
  disabled?: boolean;
  /** Its switch can't be turned off: the last tool allowed. */
  locked?: boolean;
}) => {
  const { t } = useLingui();
  const { name } = tool;
  const id = `${idPrefix}-${name}`;
  return (
    <li className="flex min-h-11 items-center gap-2 border-b px-3 py-2 last:border-b-0">
      <label
        className={
          choice === undefined
            ? "text-muted-foreground min-w-0 flex-1 truncate"
            : "min-w-0 flex-1 truncate"
        }
        htmlFor={id}
      >
        {name}
      </label>
      {choice === undefined ? (
        <NeverBadge />
      ) : (
        <Badge
          className="cursor-pointer"
          onClick={() => {
            onRead(!choice.read);
          }}
          render={
            <button
              aria-label={
                choice.read
                  ? t`${name} reads only. Change to Write`
                  : t`${name} may write. Change to Read`
              }
              disabled={disabled}
              type="button"
            />
          }
          variant={choice.read ? "outline" : "secondary"}
        >
          {choice.read ? (
            <EyeIcon data-icon="inline-start" />
          ) : (
            <PenLineIcon data-icon="inline-start" />
          )}
          {choice.read ? (
            <Trans context="what a tool may do">Read</Trans>
          ) : (
            <Trans context="what a tool may do">Write</Trans>
          )}
        </Badge>
      )}
      <Switch
        checked={choice !== undefined}
        disabled={disabled || (locked && choice !== undefined)}
        id={id}
        onCheckedChange={onAllow}
      />
    </li>
  );
};
