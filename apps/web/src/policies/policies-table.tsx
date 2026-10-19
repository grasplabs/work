import { Spinner } from "@grasp-os/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, FileTextIcon } from "lucide-react";

import { formatDate } from "../format.ts";
import type { PolicyDocument, PolicyRule } from "./policy.ts";

// The company's own policies, as the prototype lists them
// (`components/policies/policies-table.tsx`).

const policyStatusLabel: Record<PolicyDocument["status"], MessageDescriptor> = {
  reading: msg({
    message: "Reading…",
    context: "Grasp is reading an uploaded policy",
  }),
  review: msg({
    message: "Rules to review",
    context: "status of an uploaded policy",
  }),
  published: msg({
    message: "In use",
    context: "status of an uploaded policy whose rules are published",
  }),
  failed: msg({
    message: "Could not be read",
    context: "status of an uploaded policy",
  }),
};

/** How many rules a policy gave, as its status makes them count. */
const rulesText = (
  policy: PolicyDocument,
  rules: readonly PolicyRule[]
): string => {
  if (policy.status === "published") {
    const inUse = rules.filter((rule) => rule.policyId === policy.id).length;
    return plural(inUse, { one: "# rule in use", other: "# rules in use" });
  }
  if (policy.status === "review") {
    const proposed = policy.proposals.filter(
      (proposal) => proposal.decision !== "rejected"
    ).length;
    return plural(proposed, { one: "# proposed", other: "# proposed" });
  }
  return "—";
};

/** The company's own policies: which are in use, which wait for a review, and how many rules each gave. */
export const PoliciesTable = ({
  policies,
  rules,
}: {
  policies: readonly PolicyDocument[];
  rules: readonly PolicyRule[];
}) => {
  const { i18n } = useLingui();
  return (
    <div className="bg-card @container overflow-hidden rounded-xl border">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead variant="card">
              <Trans context="column: an uploaded policy">Policy</Trans>
            </TableHead>
            <TableHead className="w-40" variant="card">
              <Trans context="column: status of a policy">Status</Trans>
            </TableHead>
            <TableHead className="hidden w-40 @xl:table-cell" variant="card">
              <Trans context="column: rules drawn from a policy">Rules</Trans>
            </TableHead>
            <TableHead className="hidden w-48 @3xl:table-cell" variant="card">
              <Trans context="column: who uploaded a policy, and when">
                Uploaded
              </Trans>
            </TableHead>
            <TableHead className="w-9" variant="card">
              <span className="sr-only">
                <Trans context="column: a link that opens the policy">
                  Open
                </Trans>
              </span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {policies.length === 0 ? (
            <TableRow>
              <TableCell
                className="h-16 text-center whitespace-normal"
                colSpan={5}
                variant="card"
              >
                <span className="text-muted-foreground">
                  <Trans>
                    No policies yet. Upload one to have Grasp propose its rules.
                  </Trans>
                </span>
              </TableCell>
            </TableRow>
          ) : (
            policies.map((policy) => (
              <TableRow className="relative" key={policy.id}>
                <TableCell className="whitespace-normal" variant="roomy">
                  <div className="flex min-w-0 items-center gap-3">
                    <FileTextIcon
                      aria-hidden="true"
                      className="text-muted-foreground size-4 flex-none"
                    />
                    <div className="flex min-w-0 flex-col">
                      <Link
                        className="truncate font-medium outline-none after:absolute after:inset-0 focus-visible:underline"
                        params={{ policyId: policy.id }}
                        to="/policies/documents/$policyId"
                      >
                        {policy.title}
                      </Link>
                      <span className="text-muted-foreground truncate">
                        {policy.fileName}
                      </span>
                    </div>
                  </div>
                </TableCell>
                <TableCell variant="roomy">
                  <span
                    className={
                      policy.status === "failed" || policy.status === "review"
                        ? "text-status-attention inline-flex items-center gap-2"
                        : "inline-flex items-center gap-2"
                    }
                  >
                    {policy.status === "reading" ? <Spinner /> : null}
                    {i18n._(policyStatusLabel[policy.status])}
                  </span>
                </TableCell>
                <TableCell className="hidden @xl:table-cell" variant="roomy">
                  <span className="text-muted-foreground tabular-nums">
                    {rulesText(policy, rules)}
                  </span>
                </TableCell>
                <TableCell className="hidden @3xl:table-cell" variant="roomy">
                  <span className="text-muted-foreground">
                    {policy.uploadedBy} · {formatDate(policy.uploadedAt)}
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
