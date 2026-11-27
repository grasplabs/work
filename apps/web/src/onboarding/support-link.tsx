import { Button } from "@grasp-os/ui/components/button";
import { useLingui } from "@lingui/react/macro";

// More about what a step connects, on Grasp's support site, in a new tab:
// every connection has a page of its own there, what it reads, what it
// never reads, and how to take it away again. In a step's end, a third
// way beside its buttons: a link Button, so its words are never larger
// than theirs.

/** Grasp's support site. */
const supportUrl = "https://support.joingrasp.com";

/** The pages the setup links to, by what is connected on a step. */
const connectionPages = {
  /** The Microsoft or Google sign-in that tells who works where. */
  directory: "connections/sign-in",
  /** A staff list shared as a file. */
  staffList: "connections/staff-list",
  /** The places where documents live: SharePoint, Google Drive, Notion and the like. */
  documents: "connections/documents",
  /** The HR platform: Personio, AFAS, HiBob and the like. */
  hr: "connections/hr",
} as const;

export const SupportLink = ({
  page,
  children: label,
}: {
  page: keyof typeof connectionPages;
  children: string;
}) => {
  const { t } = useLingui();
  return (
    <Button asChild size="lg" variant="link">
      <a
        aria-label={t`${label}, on Grasp’s support site, in a new tab`}
        href={`${supportUrl}/${connectionPages[page]}`}
        rel="noopener"
        target="_blank"
      >
        {label}
      </a>
    </Button>
  );
};
