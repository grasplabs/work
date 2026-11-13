/**
 * The shared secrets on Platform: whether the old values can be revoked at
 * their providers, read live when staff ask (src/rollout/shared-secrets.ts).
 * What Secrets Store holds reaches every company by itself: the reconciler
 * deploys it, as it deploys a release.
 */
import { Button } from "@grasp-os/ui/components/button";
import { useState } from "react";

import { checkRevocationFn } from "../rollout/functions.ts";
import type {
  RevocationCheck,
  RevocationRefusal,
} from "../rollout/shared-secrets.ts";
import { Attention } from "./parts.tsx";
import { Section } from "./section.tsx";

/** What a revocation check says, secret by secret, in words. */
const checkLines = (check: RevocationCheck): string[] => [
  ...(check.revocable.length === 0
    ? []
    : [
        `Every active client runs Secrets Store's ${check.revocable.join(", ")}, read live, and none is still being provisioned: an older value of ${check.revocable.length === 1 ? "it" : "any of them"} can be revoked at its provider.`,
      ]),
  ...Object.entries(check.behind).flatMap(([name, behind]) =>
    behind.length === 0
      ? []
      : [
          `Keep the old ${name}: ${behind.join(", ")} ${behind.length === 1 ? "isn't" : "aren't"} known to run Secrets Store's value yet. Active clients are read live, and one that doesn't answer, or is still being provisioned, counts.`,
        ]
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
  // Safe only when every secret can go: anything else is a warning,
  // whatever else can.
  return {
    safe: Object.values(result.behind).every((behind) => behind.length === 0),
    lines: checkLines(result),
  };
};

/** Whether the old shared secrets can be revoked, checked when staff ask. */
export const SharedSecrets = () => {
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
      description="Once Deploy platform copies a changed secret into Secrets Store, every company is deployed again with it by itself, as a release is. Check, live, whether the old values can be revoked."
      title="Shared secrets"
    >
      {verdict === null ? null : (
        <div
          className="flex flex-col gap-1 border-t px-5 py-3"
          role={verdict.safe ? undefined : "alert"}
        >
          {verdict.lines.map((line) => (
            <p key={line}>
              {verdict.safe ? line : <Attention>{line}</Attention>}
            </p>
          ))}
        </div>
      )}
    </Section>
  );
};
