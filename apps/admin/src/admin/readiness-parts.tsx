/**
 * Platform's Readiness checklist (src/admin/readiness.ts), and the banner
 * Home shows while a required line isn't ready.
 */
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { buttonVariants } from "@grasp-os/ui/components/button";
import { cn } from "@grasp-os/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";

import type {
  CheckLink,
  CheckStatus,
  Readiness,
  ReadinessCheck,
} from "./readiness.ts";
import { Section } from "./section.tsx";

/** Where Platform holds its checklist, for a link to it. */
export const readinessId = "readiness";

/** A check's status, as the checklist says it. */
const statusWords: Readonly<Record<CheckStatus, string>> = {
  ready: "Ready",
  blocked: "Needs fixing",
  waiting: "Waiting",
  not_configured: "Not configured",
};

const statusVariant: Readonly<
  Record<CheckStatus, "passed" | "attention" | "outline">
> = {
  ready: "passed",
  blocked: "attention",
  waiting: "outline",
  not_configured: "outline",
};

/** Where each check leads, for its next step in the admin. */
const checkLinks: Readonly<
  Record<
    CheckLink,
    {
      label: string;
      to: "/platform/releases" | "/" | "/platform" | "/platform/ai";
    }
  >
> = {
  releases: { label: "Open Releases", to: "/platform/releases" },
  organizations: { label: "Open Organizations", to: "/" },
  platform: { label: "Open Platform", to: "/platform" },
  platform_ai: { label: "Open Platform → AI", to: "/platform/ai" },
};

/** A check's link, where its next step is done in the admin. */
const CheckLinkTo = ({ link }: { link: CheckLink }) => (
  <Link
    className={cn(
      buttonVariants({ size: "sm", variant: "ghost" }),
      "flex-none"
    )}
    to={checkLinks[link].to}
  >
    {checkLinks[link].label}
  </Link>
);

const CheckRow = ({ check }: { check: ReadinessCheck }) => (
  <li className="flex flex-col gap-1 border-t px-5 py-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="flex items-center gap-2">
        <span className="font-medium">{check.title}</span>
        {check.required ? null : (
          <span className="text-muted-foreground text-xs">Optional</span>
        )}
      </span>
      <Badge variant={statusVariant[check.status]}>
        {statusWords[check.status]}
      </Badge>
    </div>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <p
        className={cn(
          "min-w-0 flex-1",
          check.status === "ready" && "text-muted-foreground",
          check.required &&
            check.status === "blocked" &&
            "text-status-attention"
        )}
      >
        {check.words}
      </p>
      {check.link === undefined || check.status === "ready" ? null : (
        <CheckLinkTo link={check.link} />
      )}
    </div>
  </li>
);

/** Platform's checklist: required lines first, then optional ones. */
export const ReadinessPanel = ({ readiness }: { readiness: Readiness }) => {
  const ordered = [
    ...readiness.checks.filter(({ required }) => required),
    ...readiness.checks.filter(({ required }) => !required),
  ];
  return (
    <div id={readinessId}>
      <Section
        description={
          readiness.blocking === 0
            ? "Everything onboarding an organization needs is ready."
            : `${readiness.blocking} ${readiness.blocking === 1 ? "thing stops" : "things stop"} an organization being onboarded. Each line says what to do next.`
        }
        title="Readiness"
      >
        <ul className="flex flex-col">
          {ordered.map((check) => (
            <CheckRow check={check} key={check.id} />
          ))}
        </ul>
      </Section>
    </div>
  );
};

/** Home's banner while a required line isn't ready; nothing once all are. */
export const ReadinessBanner = ({ readiness }: { readiness: Readiness }) => {
  if (readiness.blocking === 0) {
    return null;
  }
  const first = readiness.checks.find(
    ({ required, status }) => required && status !== "ready"
  );
  return (
    <Alert aria-label="Readiness" live="polite" variant="attention">
      <TriangleAlertIcon aria-hidden />
      <AlertTitle>
        {`Grasp can't onboard an organization yet: ${readiness.blocking} ${readiness.blocking === 1 ? "thing to fix" : "things to fix"}.`}
      </AlertTitle>
      {first === undefined ? null : (
        <AlertDescription>
          <p>{`${first.title}: ${first.words}`}</p>
        </AlertDescription>
      )}
      {/* The alert's own place for its action: inside its description, a link takes the description's underline. */}
      <AlertAction placement="below">
        <Link
          className={buttonVariants({ size: "sm", variant: "outline" })}
          hash={readinessId}
          to="/platform"
        >
          Open Readiness
        </Link>
      </AlertAction>
    </Alert>
  );
};
