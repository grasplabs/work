import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  AwardIcon,
  BrainIcon,
  Building2Icon,
  CalendarIcon,
  CircleUserIcon,
  ClipboardListIcon,
  ClockIcon,
  FileTextIcon,
  GlobeIcon,
  RadarIcon,
  ServerIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect } from "react";

import { InsightPopover, StatusDot } from "./insight.tsx";
import { appTabs } from "./landscape-app.ts";
import { appProfile } from "./landscape-overview.ts";
import type { ProfileFact, ProfileKey } from "./landscape-overview.ts";
import type { LandscapeApp } from "./landscape.ts";
import { OwnerAvatar } from "./owner.tsx";
import { Facts, Section } from "./section.tsx";

// An app's Overview tab, as the prototype lays it out
// (`components/landscape/overview/`): the app's profile, its risk signals
// and the vendor's documents, its adoption and the vendor's certificates.
// Grasp records no risk signals, vendor documents, usage or certificates
// for apps yet, so those sections are the prototype's empty states.

const factIcon: Record<ProfileKey, LucideIcon> = {
  vendor: Building2Icon,
  domain: GlobeIcon,
  aiType: BrainIcon,
  hosting: ServerIcon,
  training: SparklesIcon,
  retention: ClockIcon,
  owner: CircleUserIcon,
  firstSeen: CalendarIcon,
  sources: RadarIcon,
  dpa: ShieldCheckIcon,
  certifications: AwardIcon,
  deletion: Trash2Icon,
};

const FactValue = ({ appId, fact }: { appId: string; fact: ProfileFact }) => {
  const { t, i18n } = useLingui();
  const content = (
    <>
      {fact.tone === undefined ? null : <StatusDot tone={fact.tone} />}
      {fact.person === undefined ? null : <OwnerAvatar name={fact.person} />}
      <span className="truncate">{fact.value}</span>
    </>
  );
  const { target, label } = fact;
  const tab =
    target === undefined
      ? undefined
      : appTabs.find((each) => each.segment === target.tab);
  const tabLabel = tab === undefined ? "" : i18n._(tab.label);
  return (
    <>
      {fact.insight === undefined ? (
        <span className="flex min-w-0 items-center gap-2">{content}</span>
      ) : (
        <InsightPopover
          align="end"
          insight={fact.insight}
          render={
            <Button className="max-w-full min-w-0" size="sm" variant="ghost" />
          }
        >
          {content}
        </InsightPopover>
      )}
      {target === undefined || tab === undefined ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={t`${label}: open in ${tabLabel}`}
                nativeButton={false}
                render={
                  <Link hash={target.hash} params={{ appId }} to={tab.to} />
                }
                size="icon-xs"
                variant="ghost"
              />
            }
          >
            <ArrowRightIcon />
          </TooltipTrigger>
          <TooltipContent>
            <Trans>Open in {tabLabel}</Trans>
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
};

/** Vendor, data handling and governance facts, each opening what Grasp read about it. */
const ProfileSection = ({ app }: { app: LandscapeApp }) => {
  const { t } = useLingui();
  const profile = appProfile(app);
  // Facts fill row by row, so the two columns are interleaved: left, right, left, right.
  const rows = profile.left.flatMap((fact, index) => {
    const right = profile.right[index];
    return right === undefined ? [fact] : [fact, right];
  });
  return (
    <Section
      description={t`Vendor, data handling and governance facts.`}
      title={t`App profile`}
    >
      <Facts
        columns={2}
        facts={rows.map((fact) => ({
          label: fact.label,
          icon: factIcon[fact.key],
          value: <FactValue appId={app.id} fact={fact} />,
        }))}
      />
    </Section>
  );
};

/** The signals that weigh most on the app; Grasp raises none for apps yet. */
const RiskSignalsSection = ({ appId }: { appId: string }) => {
  const { t } = useLingui();
  return (
    <Section
      action={
        <Button
          nativeButton={false}
          render={<Link params={{ appId }} to="/landscape/$appId/audit" />}
          size="sm"
          variant="outline"
        >
          <ClipboardListIcon data-icon="inline-start" />
          <Trans>History</Trans>
        </Button>
      }
      description={t`The signals that weigh most on this app.`}
      title={t`Risk signals`}
    >
      <Empty size="sm">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldCheckIcon />
          </EmptyMedia>
          <EmptyTitle>
            <Trans>No risk signals</Trans>
          </EmptyTitle>
          <EmptyDescription>
            <Trans>Nothing to raise right now.</Trans>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </Section>
  );
};

/** The documents a vendor publishes, in the order people look for them. */
const documents: { key: string; label: MessageDescriptor }[] = [
  { key: "dpa", label: msg`Data processing agreement` },
  { key: "privacy", label: msg`Privacy policy` },
  { key: "terms", label: msg`Terms and conditions` },
];

/**
 * The legal and policy documents the vendor publishes, each to download
 * from the vendor's own site. Grasp keeps none on file yet.
 */
const VendorDocumentsSection = () => {
  const { t, i18n } = useLingui();
  return (
    <Section
      description={t`Legal and policy documents the vendor publishes.`}
      id="vendor-documents"
      title={t`Vendor documents`}
    >
      <ItemGroup spacing="tight">
        {documents.map((document) => (
          <Item key={document.key} size="sm">
            <ItemMedia variant="icon">
              <FileTextIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{i18n._(document.label)}</ItemTitle>
              <ItemDescription>
                <Trans>Not on file yet.</Trans>
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    </Section>
  );
};

/** Who uses the app and how that changed over the last 30 days: nothing seen yet. */
const AdoptionSection = ({ appId }: { appId: string }) => {
  const { t } = useLingui();
  return (
    <Section
      action={
        <Badge variant="outline">
          <Trans>No data</Trans>
        </Badge>
      }
      description={t`Who uses this app, and how that changed over the last 30 days.`}
      title={t`Adoption`}
    >
      <Empty size="sm">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UsersIcon />
          </EmptyMedia>
          <EmptyTitle>
            <Trans>No usage data yet</Trans>
          </EmptyTitle>
          <EmptyDescription>
            <Trans>
              It shows once the desktop agent or single sign-on sees someone use
              the app.
            </Trans>
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            nativeButton={false}
            render={<Link params={{ appId }} to="/landscape/$appId/usage" />}
            size="sm"
            variant="outline"
          >
            <Trans>Set up usage tracking</Trans>
          </Button>
        </EmptyContent>
      </Empty>
    </Section>
  );
};

/** The certificates the vendor holds; none on file yet. */
const CertificationsSection = () => {
  const { t } = useLingui();
  return (
    <Section
      description={t`What the vendor publishes about its certificates.`}
      id="vendor-certifications"
      title={t`Certifications`}
    >
      <Empty size="sm">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AwardIcon />
          </EmptyMedia>
          <EmptyTitle>
            <Trans>No certifications on file</Trans>
          </EmptyTitle>
          <EmptyDescription>
            <Trans>Ask the vendor for SOC 2 or ISO 27001 evidence.</Trans>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </Section>
  );
};

/**
 * Keys on the Overview: the arrows move to the next tab (Data) or wrap
 * round to the last (Audit trail). Ignored while typing, and where menus,
 * lists, tabs and dialogs use the arrow keys themselves.
 */
const useOverviewShortcuts = (appId: string) => {
  const navigate = useNavigate();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (
        target?.closest(
          '[role="menu"], [role="listbox"], [role="tablist"], [role="dialog"]'
        )
      ) {
        return;
      }
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.defaultPrevented
      ) {
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        void navigate({ to: "/landscape/$appId/data", params: { appId } });
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        void navigate({ to: "/landscape/$appId/audit", params: { appId } });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [appId, navigate]);
};

/** The Overview tab: the app's profile, its risk, the vendor, and adoption. */
export const OverviewTab = ({ app }: { app: LandscapeApp }) => {
  useOverviewShortcuts(app.id);
  return (
    <div className="flex flex-col gap-6">
      <ProfileSection app={app} />
      <div className="grid gap-6 xl:grid-cols-2">
        <RiskSignalsSection appId={app.id} />
        <VendorDocumentsSection />
      </div>
      <AdoptionSection appId={app.id} />
      <CertificationsSection />
    </div>
  );
};
