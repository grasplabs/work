/**
 * The shared secrets on Platform: whether the old values can be revoked at
 * their providers, read live when staff ask (src/rollout/shared-secrets.ts).
 * What Secrets Store holds reaches every company by itself: the reconciler
 * deploys it, as it deploys a release.
 */
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import { CardContent } from "@grasp-os/ui/components/card";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { checkRevocationFn } from "../rollout/functions.ts";
import type {
  RevocationCheck,
  RevocationRefusal,
} from "../rollout/shared-secrets.ts";
import { Panel } from "./panel.tsx";

const styles = stylex.create({
  lines: { display: "flex", flexDirection: "column", gap: space["1"] },
});

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

/** What a check found: its lines, or, when an old value must stay, a warning that holds them. */
const Verdict = ({
  verdict,
}: {
  verdict: { safe: boolean; lines: string[] };
}) =>
  verdict.safe ? (
    <div {...stylex.props(styles.lines)}>
      {verdict.lines.map((line) => (
        <Text key={line} size="sm">
          {line}
        </Text>
      ))}
    </div>
  ) : (
    // Something to look at before an old value goes: said when it appears.
    <Alert variant="warning">
      <AlertDescription>
        <span {...stylex.props(styles.lines)}>
          {verdict.lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      </AlertDescription>
    </Alert>
  );

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
    <Panel
      action={
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
      }
      title="Shared secrets"
    >
      {/* What it is for in the card's body, so the card keeps one look
          before and after a check (a Card's header with nothing under
          it is drawn as a plain title card). */}
      <CardContent>
        <div {...stylex.props(styles.lines)}>
          <Text color="muted" size="sm">
            Once Deploy platform copies a changed secret into Secrets Store,
            every company is deployed again with it by itself, as a release is.
            Check, live, whether the old values can be revoked.
          </Text>
          {verdict === null ? null : <Verdict verdict={verdict} />}
        </div>
      </CardContent>
    </Panel>
  );
};
