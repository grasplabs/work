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
import { Button } from "@grasp-os/ui/components/button";
import { CardContent } from "@grasp-os/ui/components/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Link } from "@tanstack/react-router";

import { Panel } from "./panel.tsx";
import type {
  CheckLink,
  CheckStatus,
  Readiness,
  ReadinessCheck,
} from "./readiness.ts";

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
  Record<CheckStatus, "success" | "warning" | "default">
> = {
  ready: "success",
  blocked: "warning",
  waiting: "default",
  not_configured: "default",
};

/** Where each check leads, for its next step in the admin. */
const checkLinks: Readonly<
  Record<
    CheckLink,
    {
      label: string;
      to: "/platform/releases" | "/";
    }
  >
> = {
  releases: { label: "Open Releases", to: "/platform/releases" },
  organizations: { label: "Open Organizations", to: "/" },
};

/** A check's link, where its next step is done in the admin. */
const CheckLinkTo = ({ link }: { link: CheckLink }) => (
  <Button asChild size="sm" variant="ghost">
    <Link to={checkLinks[link].to}>{checkLinks[link].label}</Link>
  </Button>
);

const CheckRow = ({ check }: { check: ReadinessCheck }) => (
  <Item size="sm">
    <ItemContent>
      <ItemTitle>
        {check.title}
        {check.required ? null : <ItemDetail>Optional</ItemDetail>}
      </ItemTitle>
      <ItemDescription>{check.words}</ItemDescription>
    </ItemContent>
    <ItemActions>
      <Badge variant={statusVariant[check.status]}>
        {statusWords[check.status]}
      </Badge>
      {check.link === undefined ? null : <CheckLinkTo link={check.link} />}
    </ItemActions>
  </Item>
);

/** Platform's checklist of what isn't ready: required lines first, then optional ones. */
export const ReadinessPanel = ({ readiness }: { readiness: Readiness }) => {
  // Only what isn't ready: a line that is has nothing to do next.
  const open = readiness.checks.filter(({ status }) => status !== "ready");
  const ordered = [
    ...open.filter(({ required }) => required),
    ...open.filter(({ required }) => !required),
  ];
  return (
    <Panel
      description={
        readiness.blocking === 0
          ? "Everything onboarding an organization needs is ready."
          : `${readiness.blocking} ${readiness.blocking === 1 ? "thing stops" : "things stop"} an organization being onboarded. Each line says what to do next.`
      }
      id={readinessId}
      title="Readiness"
    >
      {ordered.length === 0 ? null : (
        <CardContent flush>
          <ItemGroup separated>
            {ordered.map((check) => (
              <CheckRow check={check} key={check.id} />
            ))}
          </ItemGroup>
        </CardContent>
      )}
    </Panel>
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
    <Alert live="polite" variant="warning">
      <AlertTitle>
        {`Grasp can't onboard an organization yet: ${readiness.blocking} ${readiness.blocking === 1 ? "thing to fix" : "things to fix"}.`}
      </AlertTitle>
      {first === undefined ? null : (
        <AlertDescription>{`${first.title}: ${first.words}`}</AlertDescription>
      )}
      <AlertAction>
        <Button asChild size="xs" variant="outline">
          <Link hash={readinessId} to="/platform">
            Open Readiness
          </Link>
        </Button>
      </AlertAction>
    </Alert>
  );
};
