/**
 * A client's quota policy on its page: the generation core applies beside
 * the one the console sets, drift flagged (`clientQuotaPolicy`).
 */
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";

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
    <p className="text-muted-foreground text-sm">Lowers no limit.</p>
  ) : (
    <ul className="font-mono text-sm">
      {entries.map(([name, value]) => (
        <li key={name}>{`${name}: ${String(value)}`}</li>
      ))}
    </ul>
  );
};

/** What the state means, in one sentence. */
const summaryOf = ({ set, inForce, state }: ClientQuotaPolicy): string => {
  const ours = generationText(set.generation);
  if (inForce === null) {
    return `The console sets ${ours}. Core couldn't be asked which it applies.`;
  }
  const theirs = generationText(inForce.generation);
  if (state === "drifted") {
    return `Core applies ${theirs}, not the console's ${ours}: it refused the console's policy.`;
  }
  if (state === "pending") {
    return `Core applies ${theirs}. The console's ${ours} waits for the client's next deploy.`;
  }
  return `Core applies ${theirs}, as the console sets.`;
};

export const QuotaPolicyCard = ({ policy }: { policy: ClientQuotaPolicy }) => (
  <Card>
    <CardHeader>
      <CardTitle>Quota policy</CardTitle>
      <CardAction>
        <Badge
          variant={policy.state === "drifted" ? "destructive" : "secondary"}
        >
          {stateLabels[policy.state]}
        </Badge>
      </CardAction>
    </CardHeader>
    <CardContent>
      <div className="flex flex-col gap-2">
        <p className="text-sm">{summaryOf(policy)}</p>
        {policy.inForce === null ? null : (
          <>
            {policy.inForce.recordedAt === null ? null : (
              <p className="text-muted-foreground text-sm">
                {`Recorded by core ${formatTime(new Date(policy.inForce.recordedAt))} (UTC).`}
              </p>
            )}
            <LoweredLimits lowered={policy.inForce.lowered} />
          </>
        )}
      </div>
    </CardContent>
  </Card>
);
