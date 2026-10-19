import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";

import { ConditionChips, RuleStatusBadge } from "./policy-parts.tsx";
import { caughtText, effectLabel } from "./policy.ts";
import type { Finding, PolicyDocument, PolicyRule } from "./policy.ts";

// The company's rules, as the prototype lists them
// (`components/policies/rules-table.tsx`).

const statusOrder = { active: 0, watching: 1, paused: 2 } as const;

/**
 * Every rule, active ones first: what it checks, what it does, and how many
 * apps it catches now. Its columns fold away as the table narrows,
 * conditions first.
 */
export const RulesTable = ({
  rules,
  policies,
  found,
}: {
  rules: readonly PolicyRule[];
  policies: readonly PolicyDocument[];
  found: readonly Finding[];
}) => {
  const { t, i18n } = useLingui();
  const sorted = rules.toSorted(
    (one, other) =>
      statusOrder[one.status] - statusOrder[other.status] ||
      one.name.localeCompare(other.name)
  );
  const source = (rule: PolicyRule) =>
    policies.find((policy) => policy.id === rule.policyId)?.title ??
    t`Made by hand`;
  return (
    <div className="bg-card @container overflow-hidden rounded-xl border">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead variant="card">
              <Trans context="column: a policy rule">Rule</Trans>
            </TableHead>
            <TableHead className="hidden @4xl:table-cell" variant="card">
              <Trans context="column: what a policy rule checks">Checks</Trans>
            </TableHead>
            <TableHead className="hidden w-24 @2xl:table-cell" variant="card">
              <Trans context="column: what a policy rule does">Does</Trans>
            </TableHead>
            <TableHead className="w-28" variant="card">
              <Trans context="column: status of a policy rule">Status</Trans>
            </TableHead>
            <TableHead className="hidden w-52 @xl:table-cell" variant="card">
              <Trans context="column: apps a policy rule catches">Apps</Trans>
            </TableHead>
            <TableHead className="w-9" variant="card">
              <span className="sr-only">
                <Trans context="column: a link that opens the rule">Open</Trans>
              </span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.length === 0 ? (
            <TableRow>
              <TableCell
                className="h-16 text-center whitespace-normal"
                colSpan={6}
                variant="card"
              >
                <span className="text-muted-foreground">
                  <Trans>
                    No rules yet. Upload a policy, or make a rule yourself.
                  </Trans>
                </span>
              </TableCell>
            </TableRow>
          ) : (
            sorted.map((rule) => (
              <TableRow className="relative" key={rule.id}>
                <TableCell className="whitespace-normal" variant="roomy">
                  <Link
                    className="font-medium outline-none after:absolute after:inset-0 focus-visible:underline"
                    params={{ ruleId: rule.id }}
                    to="/policies/rules/$ruleId"
                  >
                    {rule.name}
                  </Link>
                  <div className="text-muted-foreground">{source(rule)}</div>
                </TableCell>
                <TableCell
                  className="hidden whitespace-normal @4xl:table-cell"
                  variant="roomy"
                >
                  <ConditionChips conditions={rule.conditions} />
                </TableCell>
                <TableCell className="hidden @2xl:table-cell" variant="roomy">
                  {i18n._(effectLabel[rule.effect])}
                </TableCell>
                <TableCell variant="roomy">
                  <RuleStatusBadge status={rule.status} />
                </TableCell>
                <TableCell className="hidden @xl:table-cell" variant="roomy">
                  <span className="text-muted-foreground tabular-nums">
                    {caughtText(rule, found)}
                  </span>
                </TableCell>
                <TableCell variant="end">
                  <span className="text-muted-foreground">
                    <ChevronRightIcon aria-hidden="true" className="size-4" />
                  </span>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
};
