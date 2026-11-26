import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Section as Part,
  SectionHeader,
} from "@grasp-os/ui/components/section-header";
import {
  CircleCheckIcon,
  ClockIcon,
  HourglassIcon,
  Icon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { AgreementsAction } from "./agreements.tsx";
import { CommandButton } from "./commands.tsx";
import { startItems, started } from "./getting-started.ts";
import type { StartFacts, StartItem } from "./getting-started.ts";

type AgreementsRead = AdminSnapshot["agreements"];

// Getting a company started, at the top of its Steps: everything that
// has to be in place before its admins get in and its people get their
// interview links, in order, each with how it stands and, where it is
// Grasp's to do, the way to do it right there. Each of them has a page of
// its own (the staff window under Setup, the agreements under Details,
// the gate at the last step), which is why nobody found them in order.

/** The way to the Setup's settings, where the staff window and the sign-in are. */
const ToSettings = ({
  clientId,
  children,
}: {
  clientId: string;
  children: ReactNode;
}) => (
  <Button asChild size="sm" variant="outline">
    <Link
      params={{ clientId }}
      search={{ tab: "settings" }}
      to="/organizations/$clientId/setup"
    >
      {children}
    </Link>
  </Button>
);

/** How an item stands, as its mark and its Badge: amber for what is Grasp's to do. */
const standings: Record<
  StartItem["state"],
  { icon: IconData; badge: ReactNode }
> = {
  done: {
    icon: CircleCheckIcon,
    badge: <Badge variant="success">Done</Badge>,
  },
  todo: {
    icon: ClockIcon,
    badge: <Badge variant="warning">For Grasp to do</Badge>,
  },
  waits: { icon: HourglassIcon, badge: <Badge>Waits</Badge> },
};

/** What Grasp does about an item that is its own to do, right here. */
const ActionOf = ({
  item,
  clientId,
  agreements,
  told,
}: {
  item: StartItem;
  clientId: string;
  agreements: AgreementsRead;
  told: boolean;
}) => {
  if (item.state !== "todo") {
    return null;
  }
  if (item.id === "window") {
    return <ToSettings clientId={clientId}>Open it under Setup</ToSettings>;
  }
  if (item.id === "admin") {
    return <ToSettings clientId={clientId}>Name its admin</ToSettings>;
  }
  if (item.id === "closed") {
    return (
      <CommandButton
        clientId={clientId}
        command={{ type: "onboarding.gate.close", payload: {} }}
        confirm={{
          title: "Close the company’s Grasp?",
          description:
            "Everyone but its admins and Grasp’s staff is signed out, and nobody else comes in until Grasp gives its go.",
          action: "Close it",
        }}
      >
        Close it
      </CommandButton>
    );
  }
  return item.id === "agreements" ? (
    <AgreementsAction agreements={agreements} clientId={clientId} told={told} />
  ) : null;
};

/**
 * What it takes to get the company started, while any of it is open:
 * nothing once its team is told (or, where nobody is interviewed, once
 * all of it is in place).
 */
export const GettingStarted = ({
  clientId,
  facts,
  agreements,
}: {
  clientId: string;
  facts: StartFacts;
  /** The agreements as staff last said them, for saying them here. */
  agreements: AgreementsRead;
}) => {
  if (started(facts)) {
    return null;
  }
  return (
    <Part aria-labelledby="getting-started">
      <SectionHeader
        description="What has to be in place before its admins get in and its people get their interview links, in order. What is Grasp’s to do can be done from here."
        id="getting-started"
        title="Getting started"
        variant="group"
      />
      <ItemGroup aria-labelledby="getting-started" separated>
        {startItems(facts).map((item) => (
          <Item key={item.id}>
            <ItemMedia variant="icon">
              <Icon icon={standings[item.state].icon} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{item.title}</ItemTitle>
              <ItemDescription>{item.detail}</ItemDescription>
            </ItemContent>
            <ItemActions>
              {standings[item.state].badge}
              <ActionOf
                agreements={agreements}
                clientId={clientId}
                item={item}
                told={facts.told}
              />
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </Part>
  );
};
