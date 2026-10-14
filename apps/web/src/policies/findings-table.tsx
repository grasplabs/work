import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { MoreHorizontalIcon } from "lucide-react";

import { AppLogo } from "../connections/app-logo.tsx";
import { formatDate } from "../format.ts";
import { FindingStateText } from "./policy-parts.tsx";
import type { Finding } from "./policy.ts";

// The apps that break a rule, as the prototype lists them
// (`components/policies/findings-table.tsx`). The prototype allows an
// exception, and ends one, from a row's menu; Grasp keeps no exceptions
// yet, so the menu opens the app.

const FindingMenu = ({ finding }: { finding: Finding }) => {
  const { t } = useLingui();
  const appName = finding.app.name;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={t`Actions for ${appName}`}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuItem
            render={
              <Link
                params={{ appId: finding.app.id }}
                to="/landscape/$appId/overview"
              />
            }
          >
            <Trans>Open in the landscape</Trans>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * The apps that break a rule, one row per app and rule: what the rule does
 * to it and how many people use it. On a rule's own page the rule column is
 * left out.
 */
export const FindingsTable = ({
  found,
  showRule = true,
  empty,
}: {
  found: readonly Finding[];
  showRule?: boolean;
  empty: string;
}) => (
  <div className="bg-card @container overflow-hidden rounded-xl border">
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead variant="card">
            <Trans context="column: an app in the landscape">App</Trans>
          </TableHead>
          {showRule ? (
            <TableHead className="hidden @2xl:table-cell" variant="card">
              <Trans context="column: a policy rule">Rule</Trans>
            </TableHead>
          ) : null}
          <TableHead className="w-36" variant="card">
            <Trans context="column: what a rule does to an app">State</Trans>
          </TableHead>
          <TableHead className="hidden w-32 @xl:table-cell" variant="card">
            <Trans context="column: people who use an app">People</Trans>
          </TableHead>
          <TableHead className="w-12" variant="card">
            <span className="sr-only">
              <Trans context="column: actions on a row">Actions</Trans>
            </span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {found.length === 0 ? (
          <TableRow>
            <TableCell
              className="h-16 text-center whitespace-normal"
              colSpan={showRule ? 5 : 4}
              variant="card"
            >
              <span className="text-muted-foreground">{empty}</span>
            </TableCell>
          </TableRow>
        ) : (
          found.map((finding) => {
            const { app, rule, exception } = finding;
            const until =
              exception === undefined ? "" : formatDate(exception.until);
            return (
              <TableRow key={`${rule.id}-${app.id}`}>
                <TableCell className="whitespace-normal" variant="roomy">
                  <div className="flex min-w-0 items-center gap-3">
                    <AppLogo name={app.name} size="sm" />
                    <div className="flex min-w-0 flex-col">
                      <Link
                        className="truncate font-medium hover:underline"
                        params={{ appId: app.id }}
                        to="/landscape/$appId/overview"
                      >
                        {app.name}
                      </Link>
                      {app.vendor === null ? null : (
                        <span className="text-muted-foreground truncate">
                          {app.vendor}
                        </span>
                      )}
                    </div>
                  </div>
                </TableCell>
                {showRule ? (
                  <TableCell
                    className="hidden whitespace-normal @2xl:table-cell"
                    variant="roomy"
                  >
                    <Link
                      className="hover:underline"
                      params={{ ruleId: rule.id }}
                      to="/policies/rules/$ruleId"
                    >
                      {rule.name}
                    </Link>
                  </TableCell>
                ) : null}
                <TableCell className="whitespace-normal" variant="roomy">
                  <FindingStateText state={finding.state} />
                  {exception === undefined ? null : (
                    <div className="text-muted-foreground">
                      <Trans>Until {until}</Trans>
                    </div>
                  )}
                </TableCell>
                <TableCell className="hidden @xl:table-cell" variant="roomy">
                  <span className="text-muted-foreground tabular-nums">
                    {plural(app.users, { one: "# person", other: "# people" })}
                  </span>
                </TableCell>
                <TableCell className="text-right" variant="end">
                  <FindingMenu finding={finding} />
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  </div>
);
