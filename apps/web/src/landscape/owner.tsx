import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@grasp-os/ui/components/hover-card";
import { Trans } from "@lingui/react/macro";

// An app's owner, as the prototype shows them (`components/landscape/owner.tsx`).
// The prototype's owners have a profile (role, team, photo) from its demo
// data; Grasp names no owners yet, so an owner is their name and initials.

const nameParts = /\s+/u;

/** "Eva Bakker" as "EB". */
export const initials = (name: string): string =>
  name
    .trim()
    .split(nameParts)
    .map((part) => part.charAt(0))
    .filter((letter) => letter !== "")
    .slice(0, 2)
    .join("")
    .toLocaleUpperCase();

/** The owner's initials. */
export const OwnerAvatar = ({
  name,
  size = "sm",
}: {
  name: string;
  size?: "sm" | "default" | "lg";
}) => (
  <Avatar size={size}>
    <AvatarFallback>{initials(name)}</AvatarFallback>
  </Avatar>
);

/** An owner's avatar, or avatar and name, with who they are on hover. */
export const Owner = ({
  name,
  compact = false,
}: {
  name: string;
  compact?: boolean;
}) => (
  <HoverCard>
    <HoverCardTrigger
      render={
        <span
          aria-label={name}
          className="relative z-10 inline-flex min-w-0 cursor-default items-center gap-2"
        />
      }
    >
      <OwnerAvatar name={name} />
      {compact ? null : <span className="truncate">{name}</span>}
    </HoverCardTrigger>
    <HoverCardContent align="start" className="w-72">
      <div className="flex gap-3">
        <OwnerAvatar name={name} size="lg" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">{name}</span>
          <span className="text-muted-foreground">
            <Trans>Owner</Trans>
          </span>
        </div>
      </div>
    </HoverCardContent>
  </HoverCard>
);
