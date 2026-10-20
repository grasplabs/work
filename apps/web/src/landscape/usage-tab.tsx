import type { LandscapePerson } from "@grasp-os/shared/landscape";
import {
  Empty,
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
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { CircleUserIcon, UsersIcon } from "lucide-react";

import { formatDate, formatList } from "../format.ts";
import { NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import type { LandscapeApp } from "./landscape.ts";
import { Section } from "./section.tsx";

// An app's Usage tab, as the prototype has it
// (`components/landscape/usage/usage-tab.tsx`): who has access to the app.
// For an app found in the identity provider's grants, the people who
// granted it access for themselves: a count for everyone, and who they
// are for admins alone (core records each look). Grasp sees no sign-ins
// to apps and runs no desktop agent yet, so for any other app the tab is
// the prototype's empty state.

/** Who granted the app access, for an admin; null for anyone else. */
export type UsagePeople = Loaded<LandscapePerson[]> | null;

/** One person who granted an app access, and what they granted. */
const PersonItem = ({ person }: { person: LandscapePerson }) => {
  const { t } = useLingui();
  const lastSeen = formatDate(person.lastSeen);
  const scopes = formatList(person.scopes);
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <CircleUserIcon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{person.name ?? person.personId}</ItemTitle>
        <ItemDescription>
          {t`Granted ${scopes}. Last seen ${lastSeen}.`}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
};

/** The people who granted a found app access: who, for admins. */
const GrantedBy = ({
  count,
  people,
}: {
  count: number;
  people: UsagePeople;
}) => {
  const { t } = useLingui();
  return (
    <Section
      description={t`${plural(count, { one: "# person granted this app access for themselves.", other: "# people granted this app access for themselves." })}`}
      title={t`Usage`}
    >
      {people === null ? (
        <p className="text-muted-foreground">
          <Trans>Only admins see who they are.</Trans>
        </p>
      ) : (
        <>
          <NotLoaded page={people} />
          {people.state === "ready" ? (
            <ItemGroup spacing="tight">
              {people.data.map((person) => (
                <PersonItem key={person.personId} person={person} />
              ))}
            </ItemGroup>
          ) : null}
        </>
      )}
    </Section>
  );
};

/** The Usage tab of an app. */
export const UsageTab = ({
  app,
  people,
}: {
  app: LandscapeApp;
  people: UsagePeople;
}) => {
  const { t } = useLingui();
  const appName = app.name;
  if (app.discovered !== null) {
    return (
      <div className="flex flex-col gap-6">
        <GrantedBy count={app.users ?? 0} people={people} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <Section
        description={t`No usage recorded for this app yet.`}
        title={t`Usage`}
      >
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UsersIcon />
            </EmptyMedia>
            <EmptyTitle>
              <Trans>No connected users</Trans>
            </EmptyTitle>
            <EmptyDescription>
              <Trans>
                Grasp doesn&apos;t track who uses {appName} yet. Usage shows
                here once it does.
              </Trans>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Section>
    </div>
  );
};
