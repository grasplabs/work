/**
 * The shared secrets on Platform: rolling out what Secrets Store holds now
 * (the reconciler deploys it to every company, as it deploys a release),
 * and whether the old values can be revoked at their providers, read live
 * when staff ask (src/rollout/shared-secrets.ts).
 */
import { Button } from "@grasp-os/ui/components/button";
import { cn } from "@grasp-os/ui/lib/utils";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { checkRevocationFn, rollOutSecretsFn } from "../rollout/functions.ts";
import type {
  RevocationCheck,
  RevocationRefusal,
} from "../rollout/shared-secrets.ts";
import { useRolloutAction } from "../rollout/use-action.ts";
import { thenRefresh } from "../use-action.ts";
import { Section } from "./section.tsx";

/** Why a rotated secret's old value must be kept, in words; null when it can go. */
const keepReason = (check: RevocationCheck, name: string): string | null => {
  if (check.storeChanged.includes(name)) {
    return `Keep the old ${name}: Secrets Store changed it again since the last rollout, so roll that out first.`;
  }
  const behind = check.behind[name] ?? [];
  if (behind.length > 0) {
    return `Keep the old ${name}: ${behind.join(", ")} ${behind.length === 1 ? "isn't" : "aren't"} known to run the new value yet. Active clients are read live, and one that doesn't answer, or is still being provisioned, counts.`;
  }
  return null;
};

/** What a revocation check says, secret by secret, then what else it found, in words. */
const checkLines = (check: RevocationCheck): string[] => [
  ...(check.rotated.length === 0
    ? [
        "Secrets Store held what every company already ran when they were rolled out: Deploy platform may not have copied a new value in, so there's nothing to revoke yet.",
      ]
    : []),
  ...(check.revocable.length === 0
    ? []
    : [
        `The old ${check.revocable.join(", ")} can be revoked at ${check.revocable.length === 1 ? "its provider" : "their providers"}: every active client runs the new value, read live, and none is still being provisioned.`,
      ]),
  ...check.rotated.flatMap((name) => {
    const reason = keepReason(check, name);
    return reason === null ? [] : [reason];
  }),
  ...check.storeChanged
    .filter((name) => !check.rotated.includes(name))
    .map(
      (name) =>
        `Secrets Store changed ${name} since the last rollout: roll it out first.`
    ),
];

/** The revocation check, or `failed` when it couldn't be read. Never throws. */
const readRevocation = async (): Promise<
  RevocationCheck | RevocationRefusal | "failed"
> => {
  try {
    return await checkRevocationFn();
  } catch {
    return "failed";
  }
};

/** A revocation check, or why none could be made, in words. */
const verdictOf = (
  result: RevocationCheck | RevocationRefusal | "failed"
): { safe: boolean; lines: string[] } => {
  if (result === "failed") {
    return { safe: false, lines: ["That did not work. Try again."] };
  }
  if (result === "store_unreadable") {
    return {
      safe: false,
      lines: [
        "Secrets Store is missing a shared secret, so nothing can be told.",
      ],
    };
  }
  if (result === "nothing_rolled_out") {
    return { safe: false, lines: ["No shared secrets were rolled out yet."] };
  }
  // Safe only when every secret it rotated can go: anything else is a
  // warning, whatever else can.
  return {
    safe:
      result.rotated.length > 0 &&
      result.revocable.length === result.rotated.length,
    lines: checkLines(result),
  };
};

/**
 * Rolling the shared secrets in Secrets Store out to every company, and
 * whether the old ones can be revoked.
 */
export const SharedSecrets = () => {
  const router = useRouter();
  const { busy, failure, run } = useRolloutAction();
  const [verdict, setVerdict] = useState<{
    safe: boolean;
    lines: string[];
  } | null>(null);
  const [reading, setReading] = useState(false);
  const check = async () => {
    setReading(true);
    const result = await readRevocation();
    setReading(false);
    setVerdict(verdictOf(result));
  };
  return (
    <Section
      action={
        <div className="flex flex-none flex-wrap justify-end gap-2">
          <Button
            disabled={busy}
            onClick={() => {
              void run(
                async () =>
                  await thenRefresh(
                    async () => await rollOutSecretsFn(),
                    async () => {
                      await router.invalidate({ sync: true });
                    }
                  )
              );
            }}
            size="sm"
            variant="outline"
          >
            Roll out secrets
          </Button>
          <Button
            disabled={reading}
            onClick={() => {
              void check();
            }}
            size="sm"
            variant="outline"
          >
            Can the old ones go?
          </Button>
        </div>
      }
      description="After Deploy platform copied a rotated secret into Secrets Store, roll it out: every company is deployed again with it, as a release is. Then check, live, whether the old values can be revoked."
      title="Shared secrets"
    >
      {failure === null ? null : (
        <p className="text-destructive border-t px-5 py-3" role="alert">
          {failure}
        </p>
      )}
      {verdict === null ? null : (
        <div
          className={cn(
            "flex flex-col gap-1 border-t px-5 py-3",
            !verdict.safe && "text-status-attention"
          )}
          role={verdict.safe ? undefined : "alert"}
        >
          {verdict.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
    </Section>
  );
};
