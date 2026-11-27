import { CONTACT_ROLES } from "@grasp-os/shared/admin/onboarding-admin";
import type { ContactRole } from "@grasp-os/shared/admin/onboarding-admin";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import { Link } from "@grasp-os/ui/components/link";
import {
  Section as Part,
  SectionHeader,
} from "@grasp-os/ui/components/section-header";
import { TabsLink, TabsNav } from "@grasp-os/ui/components/tabs";
import { Text } from "@grasp-os/ui/components/text";
import { CircleUserIcon, Icon, MailIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, Link as RouterLink } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { AttioLink } from "../../../admin/attio-link.tsx";
import { OrgContract } from "../../../admin/org-contract.tsx";
import { OrgMembers } from "../../../admin/org-members.tsx";
import { useOrganization } from "../../../admin/organization.tsx";
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
 * An organization's Details, set on the page as Grasp Work sets one, its
 * tab in the address: who Grasp deals with there, one for each thing, the
 * company as Grasp's Attio has it with its people and deals, the calls
 * with it, and its papers. Its contract and its members are tabs beside
 * them (org-contract.tsx, org-members.tsx).
 *
 * Read only but for linking it in Attio: the company's own Grasp takes
 * nothing from the admin yet, so its papers and contacts can't be changed
 * here. Where the model has nothing, because core doesn't hold it yet,
 * each part says so rather than show anything made up.
 */

const styles = stylex.create({
  // The tabs, then the tab's parts a step further apart than the lines within each.
  page: { display: "flex", flexDirection: "column", gap: space["8"] },
  parts: { display: "flex", flexDirection: "column", gap: space["10"] },
  part: { display: "flex", flexDirection: "column", gap: space["6"] },
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

/** What the company does and where, once that is known: a line, no part of its own. */
const About = () => {
  const { org } = useOrganization().view;
  const about = [org.about, org.place]
    .filter((part) => part !== "")
    .join(" · ");
  return about === "" ? null : <Text color="muted">{about}</Text>;
};

/** A part of the page: its title, a line under it and its source, over what it holds. */
const DetailsPart = ({
  id,
  title,
  description,
  source,
  children,
}: {
  id: string;
  title: string;
  description: string;
  /** The outside system it comes from, beside its title. */
  source?: string;
  children: ReactNode;
}) => (
  <Part aria-labelledby={id}>
    <SectionHeader
      badge={
        source === undefined ? undefined : (
          <Badge variant="outline">{source}</Badge>
        )
      }
      description={description}
      id={id}
      size="sm"
      title={title}
      variant="group"
    />
    <div {...stylex.props(styles.part)}>{children}</div>
  </Part>
);

/** A line in a part, for what it has none of yet. */
const Quiet = ({ children }: { children: ReactNode }) => (
  <Empty align="start" size="sm">
    <EmptyHeader>
      <EmptyDescription>{children}</EmptyDescription>
    </EmptyHeader>
  </Empty>
);

/** Who Grasp deals with there: one person for each thing, or what that one is for. */
const Contacts = () => {
  const { view } = useOrganization();
  return (
    <DetailsPart
      description="One person for each thing. The interviews are with everyone else, and never show here."
      id="contacts"
      title="Who Grasp deals with"
    >
      <ItemGroup aria-labelledby="contacts" separated>
        {CONTACT_ROLES.map((role) => {
          const contact = view.contacts[role];
          const { label, what } = contactWords[role];
          return (
            <Item key={role}>
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
                <ItemTitle>{contact ? contact.name : label}</ItemTitle>
                <ItemDescription>
                  {contact
                    ? [label, contact.title, contact.email]
                        .filter((part) => part !== "")
                        .join(" · ")
                    : what}
                </ItemDescription>
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
      </ItemGroup>
    </DetailsPart>
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
    <DetailsPart
      description={
        fromNotes
          ? "Every call with the company, from its notes in Attio."
          : "Every call with the company, with who was in it."
      }
      id="calls"
      source={sourceNames.attio}
      title="Calls"
    >
      {deal === undefined ? null : (
        <Text color="muted" size="sm">
          {[deal.name, deal.stage?.title ?? "", deal.owner ?? ""]
            .filter((part) => part !== "")
            .join(" · ")}
        </Text>
      )}
      {calls.length === 0 ? (
        <Quiet>{noCallsLine(crm)}</Quiet>
      ) : (
        <ItemGroup aria-labelledby="calls" separated>
          {calls.map((call, index) => (
            <Item
              // Two calls can share a day and a title; their order is the newest first.
              key={`${call.on}-${call.title}-${index}`}
              size="sm"
            >
              <ItemContent>
                <ItemTitle>{call.title || "A call with no title"}</ItemTitle>
                <ItemDescription>
                  {call.with.length === 0
                    ? formatDate(call.on)
                    : `${formatDate(call.on)} · With ${formatList(call.with)}`}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
    </DetailsPart>
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

/** A name or line of Attio's, or that it says none. */
const knownOr = (value: string): string => (value === "" ? "Not known" : value);

/** What Attio says of the company: its record, its deals and its people. */
const CrmRecordLines = ({ records }: { records: CrmRecords }) => {
  const { company, deals, people } = records;
  return (
    <>
      <KeyValueList
        divided
        items={[
          {
            id: "name",
            label: "Name in Attio",
            value: knownOr(company.name ?? ""),
          },
          {
            id: "domains",
            label: "Domains",
            value: knownOr(formatList(company.domains)),
          },
          {
            id: "categories",
            label: "Categories",
            value: knownOr(formatList(company.categories)),
          },
          {
            id: "employees",
            label: "Employees",
            value: knownOr(company.employeeRange ?? ""),
          },
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
      <Part aria-labelledby="deals">
        <SectionHeader id="deals" size="sm" title="Deals" variant="group" />
        {deals.length === 0 ? (
          <Quiet>None in Attio.</Quiet>
        ) : (
          <ItemGroup aria-labelledby="deals" separated>
            {deals.map((deal, index) => (
              // Two deals can share a name; their order is Attio's.
              <Item key={`${deal.name}-${index}`} size="sm">
                <ItemContent>
                  <ItemTitle>{deal.name || "A deal with no name"}</ItemTitle>
                  <ItemDescription>{dealWords(deal)}</ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        )}
      </Part>
      <Part aria-labelledby="people">
        <SectionHeader id="people" size="sm" title="People" variant="group" />
        {people.length === 0 ? (
          <Quiet>None in Attio.</Quiet>
        ) : (
          <ItemGroup aria-labelledby="people" separated>
            {people.map((person, index) => (
              // Two people can share a name.
              <Item key={`${person.name}-${index}`} size="sm">
                <ItemContent>
                  <ItemTitle>{person.name || "No name"}</ItemTitle>
                  <ItemDescription>
                    {[person.title, person.email]
                      .filter((part) => part !== "")
                      .join(" · ")}
                  </ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        )}
      </Part>
    </>
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
    <DetailsPart
      description={crmLine(crm)}
      id="crm"
      source={sourceNames.attio}
      title="In the CRM"
    >
      {crm.state === "read" ? <CrmRecordLines records={crm.records} /> : null}
      <AttioLink clientId={admin.client.id} recordId={recordId} />
    </DetailsPart>
  );
};

/** One line of the papers, or that nothing stands there yet; an address's lines one after the other. */
const paperOf = (label: string, value: string | string[]) => {
  const lines = (typeof value === "string" ? [value] : value).filter(
    (line) => line !== ""
  );
  return {
    id: label,
    label,
    value: lines.length === 0 ? "Not known yet" : lines.join(", "),
  };
};

/** Its papers: as it stands on the contract and on every invoice. */
const Papers = () => {
  const { company, unknown } = useOrganization().view;
  return (
    <DetailsPart
      description="As it stands on the contract and on every invoice."
      id="papers"
      title="Its papers"
    >
      <KeyValueList
        divided
        items={[
          // Without a contract, the model's name for it is only the company's own.
          paperOf(
            "Name on the contract",
            unknown.contract ? "" : company.legalName
          ),
          paperOf("Website", company.url),
          paperOf("Company register number", company.register),
          paperOf("VAT number", company.vat),
          paperOf("Address", company.address),
        ]}
        orientation="horizontal"
      />
    </DetailsPart>
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

/** One tab: a link to the Details with its search, as each tab has its own address. */
const TabLink = ({
  clientId,
  tab,
  current,
}: {
  clientId: string;
  tab: DetailTab;
  current: boolean;
}) => (
  <TabsLink asChild current={current}>
    <RouterLink
      params={{ clientId }}
      search={tab === "details" ? {} : { tab }}
      to="/organizations/$clientId/details"
    >
      {tabWords[tab]}
    </RouterLink>
  </TabsLink>
);

const Details = () => {
  const { tab = "details" } = Route.useSearch();
  const { clientId } = Route.useParams();
  return (
    <div {...stylex.props(styles.page)}>
      <TabsNav aria-label="Details" variant="line">
        {detailTabs.map((each) => (
          <TabLink
            clientId={clientId}
            current={each === tab}
            key={each}
            tab={each}
          />
        ))}
      </TabsNav>
      {tab === "details" ? (
        <div {...stylex.props(styles.parts)}>
          <About />
          <Contacts />
          <CrmPart />
          <Calls />
          <Papers />
        </div>
      ) : null}
      {tab === "contract" ? <OrgContract /> : null}
      {tab === "members" ? <OrgMembers /> : null}
    </div>
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
