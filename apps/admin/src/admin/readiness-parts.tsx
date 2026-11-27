/**
 * Platform's Readiness (src/admin/readiness.ts): a figure that says at a
 * glance whether anything stops onboarding, the lines that aren't ready
 * while one isn't, and the one-line banner across the frame while a
 * required line isn't ready.
 */
import { Alert, AlertAction, AlertTitle } from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Stat } from "@grasp-os/ui/components/stat";
import { Link } from "@tanstack/react-router";

import { PagePart } from "./page-part.tsx";
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

/** The lines that aren't ready, required ones first: a line that is has nothing to do next. */
const openChecks = (readiness: Readiness): ReadinessCheck[] => {
  const open = readiness.checks.filter(({ status }) => status !== "ready");
  return [
    ...open.filter(({ required }) => required),
    ...open.filter(({ required }) => !required),
  ];
};

/** Whether anything stops onboarding an organization, as a figure. */
export const ReadinessFigure = ({ readiness }: { readiness: Readiness }) => {
  const { blocking } = readiness;
  const optional = openChecks(readiness).length - blocking;
  if (blocking > 0) {
    return (
      <Stat
        change={`${blocking} ${blocking === 1 ? "thing stops" : "things stop"} a new organization`}
        label="Onboarding"
        value="Blocked"
        variant="warning"
      />
    );
  }
  return (
    <Stat
      change={
        optional > 0
          ? `${optional} optional ${optional === 1 ? "line" : "lines"} to set up`
          : "Nothing stops a new organization"
      }
      label="Onboarding"
      value="Ready"
    />
  );
};

/**
 * What isn't ready, each line saying what to do next: required lines
 * first, then optional ones. Nothing while every line is ready, which the
 * figure says.
 */
export const ReadinessPart = ({ readiness }: { readiness: Readiness }) => {
  const ordered = openChecks(readiness);
  if (ordered.length === 0) {
    return null;
  }
  return (
    <PagePart
      description={
        readiness.blocking === 0
          ? "Onboarding an organization needs nothing more. Each line says what to do next."
          : `${readiness.blocking} ${readiness.blocking === 1 ? "thing stops" : "things stop"} an organization being onboarded. Each line says what to do next.`
      }
      id={readinessId}
      title="Readiness"
    >
      <ItemGroup aria-labelledby={readinessId} separated>
        {ordered.map((check) => (
          <CheckRow check={check} key={check.id} />
        ))}
      </ItemGroup>
    </PagePart>
  );
};

/**
 * The banner across the top of the frame while a required line isn't
 * ready, in one line: how many things stop an organization being
 * onboarded, and the way to Readiness, which says what each is. Nothing
 * once all are. `onClose` sets it aside.
 */
export const ReadinessBanner = ({
  readiness,
  onClose,
}: {
  readiness: Readiness;
  onClose: () => void;
}) => {
  if (readiness.blocking === 0) {
    return null;
  }
  return (
    <Alert
      appearance="banner"
      live="polite"
      onClose={onClose}
      variant="warning"
    >
      <AlertTitle>
        {`Grasp can't onboard an organization yet: ${readiness.blocking} ${readiness.blocking === 1 ? "thing to fix" : "things to fix"}.`}
      </AlertTitle>
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
