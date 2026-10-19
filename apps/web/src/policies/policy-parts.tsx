import { Badge } from "@grasp-os/ui/components/badge";
import { useLingui } from "@lingui/react/macro";

import { conditionText, findingStateLabel, ruleStatusLabel } from "./policy.ts";
import type { FindingState, RuleCondition, RuleStatus } from "./policy.ts";

// The small parts of the Policies pages, as the prototype draws them
// (`components/policies/policy-parts.tsx`).

const stateDot: Record<FindingState, string> = {
  blocked: "bg-status-attention size-1.75 flex-none rounded-full",
  flagged: "bg-status-attention size-1.75 flex-none rounded-full",
  watching: "bg-muted-foreground size-1.75 flex-none rounded-full",
  excepted: "bg-status-agreed size-1.75 flex-none rounded-full",
};

/** What a rule does to an app, with a dot: orange when it acts, grey when it would, green when excepted. */
export const FindingStateText = ({ state }: { state: FindingState }) => {
  const { i18n } = useLingui();
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span aria-hidden="true" className={stateDot[state]} />
      {i18n._(findingStateLabel[state])}
    </span>
  );
};

export const RuleStatusBadge = ({ status }: { status: RuleStatus }) => {
  const { i18n } = useLingui();
  return (
    <Badge variant={status === "active" ? "secondary" : "outline"}>
      {i18n._(ruleStatusLabel[status])}
    </Badge>
  );
};

/** A rule's conditions as chips, every one of which must hold. */
export const ConditionChips = ({
  conditions,
}: {
  conditions: readonly RuleCondition[];
}) => (
  <div className="flex flex-wrap gap-1.5">
    {conditions.map((condition) => {
      const text = conditionText(condition);
      return (
        <Badge key={text} variant="outline">
          {text}
        </Badge>
      );
    })}
  </div>
);

/** The passage in a policy a rule comes from, as a quote. */
export const PolicyExcerpt = ({ text }: { text: string }) => (
  <blockquote className="text-muted-foreground border-l-2 pl-3">
    {text}
  </blockquote>
);
