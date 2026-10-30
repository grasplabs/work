/**
 * A client's quota policy on its Setup: the generation core applies beside
 * the one the admin sets, drift flagged (`clientQuotaPolicy`).
 */
import { Badge } from "@grasp-os/ui/components/badge";
import { CardContent } from "@grasp-os/ui/components/card";

import { Section } from "../admin/section.tsx";
import { formatTime } from "../releases/format.ts";
import type {
  ClientQuotaPolicy,
  QuotaGeneration,
  QuotaPolicyState,
} from "./quota-policy.ts";

const stateLabels: Record<QuotaPolicyState, string> = {
  in_sync: "In sync",
  drifted: "Drift",
  pending: "Waiting for deploy",
  unknown: "Unknown",
};

/** A generation as staff read it. */
const generationText = (generation: number): string =>
  generation === 0 ? "the platform's own" : `generation ${generation}`;

/** What a policy lowers, one limit a line; the platform's own lowers none. */
const LoweredLimits = ({ lowered }: Pick<QuotaGeneration, "lowered">) => {
  const entries = Object.entries(lowered);
  return entries.length === 0 ? (
    <p className="text-muted-foreground">Lowers no limit.</p>
  ) : (
    <ul className="font-mono">
      {entries.map(([name, value]) => (
        <li key={name}>{`${name}: ${String(value)}`}</li>
      ))}
    </ul>
  );
};

/** What the state means, in one sentence. */
export const summaryOf = ({
  set,
  inForce,
  state,
}: ClientQuotaPolicy): string => {
  const ours = generationText(set.generation);
  if (inForce === null) {
    const sets = set.generation === 0 ? "sets no policy" : `sets ${ours}`;
    return `The admin ${sets}. Core couldn't be asked which it applies.`;
  }
  const theirs = generationText(inForce.generation);
  if (state === "pending") {
    const waiting =
      set.generation === 0 ? "change" : generationText(set.generation);
    return `Core applies ${theirs}. The admin's ${waiting} waits for the client's next deploy.`;
  }
  if (state !== "drifted") {
    return `Core applies ${theirs}, as the admin sets.`;
  }
  if (set.generation === 0) {
    // Core never goes back to an older policy: it keeps the highest it
    // recorded, whatever the admin sets now.
    return `Core applies ${theirs}, though the admin sets none: core keeps the highest generation it recorded.`;
  }
  if (inForce.generation === set.generation) {
    return `Core applies ${theirs} with other limits than the admin's: it refused the admin's policy.`;
  }
  return `Core applies ${theirs}, not the admin's ${ours}: it refused the admin's policy.`;
};

export const QuotaPolicyCard = ({ policy }: { policy: ClientQuotaPolicy }) => (
  <Section
    action={
      <Badge variant={policy.state === "drifted" ? "attention" : "secondary"}>
        {stateLabels[policy.state]}
      </Badge>
    }
    description={summaryOf(policy)}
    title="Quota policy"
  >
    <CardContent>
      {policy.inForce === null ? null : (
        <div className="flex flex-col gap-1">
          <span className="font-medium">{`Core applies ${generationText(policy.inForce.generation)}`}</span>
          {policy.inForce.recordedAt === null ? null : (
            <p className="text-muted-foreground">
              {`Recorded by core ${formatTime(new Date(policy.inForce.recordedAt))} (UTC).`}
            </p>
          )}
          <LoweredLimits lowered={policy.inForce.lowered} />
        </div>
      )}
      {/* What the admin sets, beside it: what runs now against what a deploy brings. */}
      <div className="flex flex-col gap-1">
        <span className="font-medium">{`The admin sets ${policy.set.generation === 0 ? "no policy" : generationText(policy.set.generation)}`}</span>
        <LoweredLimits lowered={policy.set.lowered} />
      </div>
    </CardContent>
  </Section>
);
