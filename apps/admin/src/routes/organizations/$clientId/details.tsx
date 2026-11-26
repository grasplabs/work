import { CONTACT_ROLES } from "@grasp-os/shared/admin/onboarding-admin";
import type { ContactRole } from "@grasp-os/shared/admin/onboarding-admin";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { CardContent } from "@grasp-os/ui/components/card";
import { Heading } from "@grasp-os/ui/components/heading";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGrid,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import { Link } from "@grasp-os/ui/components/link";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { Text } from "@grasp-os/ui/components/text";
import { CircleUserIcon, Icon, MailIcon } from "@grasp-os/ui/lib/icons";
import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { AttioLink } from "../../../admin/attio-link.tsx";
import { OrgContract } from "../../../admin/org-contract.tsx";
import { OrgMembers } from "../../../admin/org-members.tsx";
import { useOrganization } from "../../../admin/organization.tsx";
import { Panel, PanelNote } from "../../../admin/panel.tsx";
import { sourceNames } from "../../../admin/sections.ts";
import {
  addSecretStep,
  formatDate,
  formatList,
  money,
} from "../../../admin/words.ts";
import type { AttioReadError } from "../../../crm/attio.ts";
import type { Crm, CrmDeal, CrmRecords } from "../../../crm/crm.ts";

/**
 * An organization's Details, as the prototype has them
 * (grasplabs/prototype `components/admin/org-details.tsx` and the Attio
 * panel of `source-panels.tsx`): who Grasp deals with there, one for each
 * thing, the company as Grasp's Attio has it with its people and deals,
 * the calls with it, and its papers. Its contract and its members are
 * tabs beside them (org-contract.tsx, org-members.tsx).
 *
 * Read only: the prototype corrects the papers and the contacts here, but
 * the company's own Grasp takes nothing from the admin yet, so nothing
 * here can be changed. Where the model has nothing, because core doesn't
 * hold it yet, each part says so rather than show anything made up.
 */

const styles = stylex.create({
  // Each tab's parts, under the tabs.
  tab: {
    display: "flex",
    flexDirection: "column",
    gap: space["6"],
    paddingBlockStart: space["4"],
  },
  part: { display: "flex", flexDirection: "column", gap: space["2"] },
  muted: { color: colors.mutedForeground },
  lines: { display: "flex", flexDirection: "column" },
});

/** Each contact by what they are there for, and what that is. */
const contactWords: Record<ContactRole, { label: string; what: string }> = {
  sponsor: { label: "Sponsor", what: "Wants this to happen, and decides." },
  admin: {
    label: "Admin",
    what: "Runs the company’s own onboarding and its workspace.",
  },
  billing: { label: "Billing", what: "Gets the invoices." },
  privacy: {
    label: "Privacy",
    what: "Answers for how the company handles personal data.",
  },
};

/** What the company does and where, once that is known: a line, no card of its own. */
const About = () => {
  const { org } = useOrganization().view;
  const about = [org.about, org.place]
    .filter((part) => part !== "")
    .join(" · ");
  return about === "" ? null : (
    <Text color="muted" size="sm">
      {about}
    </Text>
  );
};

/** Who Grasp deals with there: one person for each thing, or what that one is for. */
const Contacts = () => {
  const { view } = useOrganization();
  return (
    <Panel
      description="One person for each thing. The interviews are with everyone else, and never show here."
      title="Who Grasp deals with"
    >
      <CardContent>
        <ItemGrid>
          {CONTACT_ROLES.map((role) => {
            const contact = view.contacts[role];
            const { label, what } = contactWords[role];
            return (
              <Item key={role} size="sm">
                <ItemMedia>
                  {contact ? (
                    <Avatar decorative name={contact.name}>
                      <AvatarFallback />
                    </Avatar>
                  ) : (
                    // Nobody yet: a quiet place for a person, never an outline that reads as something that failed to load.
                    <Icon icon={CircleUserIcon} />
                  )}
                </ItemMedia>
                <ItemContent>
                  <ItemDescription>{label}</ItemDescription>
                  {contact ? (
                    <>
                      <ItemTitle>{contact.name}</ItemTitle>
                      <ItemDescription>
                        {[contact.title, contact.email]
                          .filter((part) => part !== "")
                          .join(" · ")}
                      </ItemDescription>
                    </>
                  ) : (
                    <ItemDescription>{what}</ItemDescription>
                  )}
                </ItemContent>
                {contact && contact.email !== "" ? (
                  <ItemActions>
                    <Button
                      aria-label={`Write to ${contact.name}`}
                      asChild
                      size="icon-sm"
                      variant="outline"
                    >
                      <a href={`mailto:${contact.email}`}>
                        <Icon icon={MailIcon} />
                      </a>
                    </Button>
                  </ItemActions>
                ) : null}
              </Item>
            );
          })}
        </ItemGrid>
      </CardContent>
    </Panel>
  );
};

/**
 * The deal the calls are about, as the prototype's Calls panel heads them:
 * the one won, or else the latest Attio lists.
 */
const mainDeal = (deals: readonly CrmDeal[]): CrmDeal | undefined =>
  deals.find((deal) => deal.stage?.kind === "won") ?? deals[0];

/** What the Calls panel says when it has no calls to list. */
const noCallsLine = (crm: Crm): string => {
  switch (crm.state) {
    case "read": {
      return crm.records.calls === null
        ? "Attio has no meetings or notes the admin can read."
        : "No call with the company in Attio yet.";
    }
    case "unread": {
      return `Attio can’t be read for it now: ${attioUnreadWords[crm.error]}.`;
    }
    case "not_linked": {
      return "Once it is linked to its company in Attio, above, this fills in by itself.";
    }
    case "not_connected": {
      return `Once ${sourceNames.attio} is connected, this fills in by itself. ${addSecretStep("ATTIO_READ_KEY")}`;
    }
    default: {
      return crm satisfies never;
    }
  }
};

/**
 * Every call with the company, with who of it was in it, as the prototype's
 * Attio panel has them: its meetings in Attio, the newest first, or, in a
 * workspace without them, its notes there. Headed by the deal, its stage
 * and who at Grasp owns it.
 */
const Calls = () => {
  const { crm } = useOrganization().admin;
  const records = crm.state === "read" ? crm.records : null;
  const calls = records?.calls?.calls ?? [];
  const deal = records === null ? undefined : mainDeal(records.deals);
  const fromNotes = records?.calls?.from === "notes";
  return (
    <Panel
      action={<Badge variant="outline">{sourceNames.attio}</Badge>}
      description={
        fromNotes
          ? "Every call with the company, from its notes in Attio."
          : "Every call with the company, with who was in it."
      }
      title="Calls"
    >
      {deal === undefined ? null : (
        <PanelNote>
          {[deal.name, deal.stage?.title ?? "", deal.owner ?? ""]
            .filter((part) => part !== "")
            .join(" · ")}
        </PanelNote>
      )}
      {calls.length === 0 ? (
        <PanelNote>{noCallsLine(crm)}</PanelNote>
      ) : (
        <CardContent flush>
          <ItemGroup separated>
            {calls.map((call, index) => (
              <Item
                // Two calls can share a day and a title; their order is the newest first.
                key={`${call.on}-${call.title}-${index}`}
                size="sm"
              >
                <ItemContent>
                  <ItemDescription>{formatDate(call.on)}</ItemDescription>
                  <ItemTitle>{call.title || "A call with no title"}</ItemTitle>
                  {call.with.length === 0 ? null : (
                    <ItemDescription>{`With ${formatList(call.with)}`}</ItemDescription>
                  )}
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </CardContent>
      )}
    </Panel>
  );
};

/** Why Attio wasn't read now, as the rest of a sentence. */
const attioUnreadWords: Record<AttioReadError, string> = {
  refused: "Attio turned the admin’s key away",
  not_found: "Attio has no such company",
  invalid_answer: "what Attio answered can’t be read",
  timeout: "Attio didn’t answer in time",
  no_answer: "the request to Attio failed",
};

/** What the CRM part says in a line under its title. */
const crmLine = (crm: Crm): string => {
  switch (crm.state) {
    case "not_connected": {
      return `${sourceNames.attio} isn’t connected yet. Once it is, this fills in by itself. ${addSecretStep("ATTIO_READ_KEY")}`;
    }
    case "not_linked": {
      return "Not linked to its company in Attio yet. Link it by the company’s record id, and this fills in by itself.";
    }
    case "unread": {
      return `Attio can’t be read for it now: ${attioUnreadWords[crm.error]}.`;
    }
    case "read": {
      return "As Grasp’s CRM has the company, its people and its deals.";
    }
    default: {
      return crm satisfies never;
    }
  }
};

/** One fact Attio has of the company, or that it doesn't say. */
const crmFact = (id: string, label: string, value: string) => ({
  id,
  label,
  value:
    value === "" ? (
      <span {...stylex.props(styles.muted)}>Not known</span>
    ) : (
      value
    ),
});

/** A deal in a line: its stage, what it is worth, and who owns it. */
const dealWords = (deal: CrmDeal): string =>
  [
    deal.stage?.title ?? "",
    deal.value === null
      ? ""
      : money(deal.value.amount, deal.value.currency ?? "EUR"),
    deal.owner === null ? "" : `owned by ${deal.owner}`,
  ]
    .filter((part) => part !== "")
    .join(" · ");

/** A part of what Attio says: its title over its rows, or that Attio has none. */
const CrmList = ({
  title,
  rows,
}: {
  title: string;
  rows: readonly { key: string; name: string; detail: string }[];
}) => (
  <div {...stylex.props(styles.part)}>
    <Heading level={3} size="2xs">
      {title}
    </Heading>
    {rows.length === 0 ? (
      <Text color="muted" size="sm">
        None in Attio.
      </Text>
    ) : (
      <ItemGroup>
        {rows.map((row) => (
          <Item key={row.key} size="sm">
            <ItemContent>
              <ItemTitle>{row.name}</ItemTitle>
              {row.detail === "" ? null : (
                <ItemDescription>{row.detail}</ItemDescription>
              )}
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    )}
  </div>
);

/** What Attio says of the company: its record, its deals and its people. */
const CrmRecordLines = ({ records }: { records: CrmRecords }) => {
  const { company, deals, people } = records;
  return (
    <CardContent>
      <div {...stylex.props(styles.tab)}>
        <KeyValueList
          divided
          items={[
            crmFact("name", "Name in Attio", company.name ?? ""),
            crmFact("domains", "Domains", formatList(company.domains)),
            crmFact("categories", "Categories", formatList(company.categories)),
            crmFact("employees", "Employees", company.employeeRange ?? ""),
          ]}
          orientation="horizontal"
        />
        {company.url === null ? null : (
          <Text size="sm">
            <Link external href={company.url}>
              Open it in Attio
            </Link>
          </Text>
        )}
        <CrmList
          rows={deals.map((deal, index) => ({
            // Two deals can share a name; their order is Attio's.
            key: `${deal.name}-${index}`,
            name: deal.name || "A deal with no name",
            detail: dealWords(deal),
          }))}
          title="Deals"
        />
        <CrmList
          rows={people.map((person, index) => ({
            // Two people can share a name.
            key: `${person.name}-${index}`,
            name: person.name || "No name",
            detail: [person.title, person.email]
              .filter((part) => part !== "")
              .join(" · "),
          }))}
          title="People"
        />
      </div>
    </CardContent>
  );
};

/**
 * The company in Grasp's CRM: what Attio says of it, its deals and its
 * people, and the company record it is linked to, which staff link or
 * change here.
 */
const CrmPart = () => {
  const { admin } = useOrganization();
  const { crm } = admin;
  const recordId = crm.state === "not_linked" ? null : crm.recordId;
  return (
    <Panel
      action={<Badge variant="outline">{sourceNames.attio}</Badge>}
      description={crmLine(crm)}
      title="In the CRM"
    >
      {crm.state === "read" ? <CrmRecordLines records={crm.records} /> : null}
      <AttioLink clientId={admin.client.id} recordId={recordId} />
    </Panel>
  );
};

/** One line of the papers: what stands there, or that nothing does yet. */
const paperOf = (id: string, label: string, value: string | string[]) => {
  const lines = (typeof value === "string" ? [value] : value).filter(
    (line) => line !== ""
  );
  return {
    id,
    label,
    value:
      lines.length === 0 ? (
        <span {...stylex.props(styles.muted)}>Not known yet</span>
      ) : (
        <span {...stylex.props(styles.lines)}>
          {lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      ),
  };
};

/** Its papers: as it stands on the contract and on every invoice. */
const Papers = () => {
  const { company, unknown } = useOrganization().view;
  return (
    <Panel
      description="As it stands on the contract and on every invoice."
      title="Its papers"
    >
      <CardContent>
        <KeyValueList
          divided
          items={[
            // Without a contract, the model's name for it is only the company's own.
            paperOf(
              "name",
              "Name on the contract",
              unknown.contract ? "" : company.legalName
            ),
            paperOf("website", "Website", company.url),
            paperOf("register", "Company register number", company.register),
            paperOf("vat", "VAT number", company.vat),
            paperOf("address", "Address", company.address),
          ]}
          orientation="horizontal"
        />
      </CardContent>
    </Panel>
  );
};

const detailTabs = ["details", "contract", "members"] as const;
type DetailTab = (typeof detailTabs)[number];

const tabWords: Record<DetailTab, string> = {
  details: "Details",
  contract: "Contract",
  members: "Members",
};

/** The tab in the address; the details, the first, have none. */
interface DetailsSearch {
  tab?: Exclude<DetailTab, "details">;
}

const Details = () => {
  const { tab = "details" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <Tabs
      onValueChange={(value) => {
        const chosen = detailTabs.find((each) => each === value);
        void navigate({
          search:
            chosen === undefined || chosen === "details" ? {} : { tab: chosen },
        });
      }}
      value={tab}
    >
      <TabsList aria-label="Details" variant="line">
        {detailTabs.map((each) => (
          <TabsTrigger key={each} value={each}>
            {tabWords[each]}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="details">
        <div {...stylex.props(styles.tab)}>
          <About />
          <Contacts />
          <CrmPart />
          <Calls />
          <Papers />
        </div>
      </TabsContent>
      <TabsContent value="contract">
        <div {...stylex.props(styles.tab)}>
          <OrgContract />
        </div>
      </TabsContent>
      <TabsContent value="members">
        <div {...stylex.props(styles.tab)}>
          <OrgMembers />
        </div>
      </TabsContent>
    </Tabs>
  );
};

/** An organization's Details, its tab in the address: the company, its contract and its members. */
export const Route = createFileRoute("/organizations/$clientId/details")({
  validateSearch: (search: Record<string, unknown>): DetailsSearch => {
    const tab = detailTabs.find((each) => each === search.tab);
    return tab === undefined || tab === "details" ? {} : { tab };
  },
  component: Details,
});
