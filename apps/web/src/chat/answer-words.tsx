import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Link } from "@grasp-os/ui/components/link";
import { MarkdownLinkProvider } from "@grasp-os/ui/components/markdown";
import type { MarkdownLink } from "@grasp-os/ui/components/markdown";
import { Text } from "@grasp-os/ui/components/text";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import type { ReactNode } from "react";

import { linkAddress } from "../link-address.ts";

// The agent's words, as Damsko's Markdown draws them (the answer's
// MessageResponse, its thinking's ReasoningContent), with one rule of
// Grasp's for every link the model wrote: a link out of Grasp asks first,
// and carries no address a middle click or the browser's own "open link"
// could follow past the question; any other (a scheme of its own, a
// picture) is its words alone, whatever the answer says.

/** The links out of Grasp a click may open. */
const leavingSchemes: ReadonlySet<string> = new Set([
  "http",
  "https",
  "mailto",
]);

/**
 * A link out of Grasp: a button until the person says yes, then opened in
 * a tab of its own without this page as its opener. The question names
 * where it leads as the browser will go there, in ASCII (link-address.ts),
 * and that is what opens; what isn't a URL is its words alone.
 */
export const LeavingLink = ({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) => {
  const [asking, setAsking] = useState(false);
  const address = linkAddress(href, window.location.href);
  if (address === undefined) {
    return <span>{children}</span>;
  }
  return (
    <>
      <Link asChild>
        <button
          onClick={() => {
            setAsking(true);
          }}
          type="button"
        >
          {children}
        </button>
      </Link>
      <AlertDialog onOpenChange={setAsking} open={asking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Open external link?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>You’re about to visit an external website.</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Text size="sm" wrap="anywhere">
            {address.href}
          </Text>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setAsking(false);
                window.open(address.href, "_blank", "noopener,noreferrer");
              }}
            >
              <Trans>Open link</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

/** One of the agent's links: out of Grasp (`//host` too), asked first; else its words alone. */
const answerLink = (link: MarkdownLink): ReactNode =>
  link.type !== "image" &&
  (leavingSchemes.has(link.scheme) || link.href.startsWith("//")) ? (
    <LeavingLink href={link.href}>{link.children}</LeavingLink>
  ) : (
    <span>{link.children}</span>
  );

/** Holds every link of the agent's words inside it to Grasp's rule. */
export const AnswerLinks = ({ children }: { children: ReactNode }) => (
  <MarkdownLinkProvider renderLink={answerLink}>
    {children}
  </MarkdownLinkProvider>
);
