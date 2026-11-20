import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import type { ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogContent,
  AlertDialogTitle,
} from "../grasp/alert-dialog/index.ts";
import { Link } from "../grasp/link/index.ts";
import { Markdown } from "../grasp/markdown/index.ts";
import type { MarkdownLink } from "../grasp/markdown/index.ts";

// The agent's answer, as Grasp UI draws one: its Markdown (the library's,
// paced while it is written). The model's own links are the host's to draw
// (`renderLink`): out of Grasp, a button that asks first and carries no
// address a middle click or the browser's own "open link" could follow
// past the question; anything else (a note link, a scheme of its own), its
// words alone, whatever the answer says.

/** A link out of Grasp: opened in its own tab, once the person says so. */
const LeavingLink = ({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Link
        render={
          <button
            onClick={() => {
              setAsking(true);
            }}
            type="button"
          >
            {children}
          </button>
        }
      >
        {children}
      </Link>
      <AlertDialog
        onOpenChange={(open, { returnValue }) => {
          setAsking(open);
          if (returnValue === "open") {
            window.open(href, "_blank", "noopener,noreferrer");
          }
        }}
        open={asking}
      >
        <AlertDialogContent>
          <AlertDialogTitle>{t`Open external link?`}</AlertDialogTitle>
          <AlertDialogDescription>{href}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
            <AlertDialogAction value="open" variant="ink">
              {t`Open link`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

/** The links out of Grasp a click may open. */
const leavingSchemes = new Set(["http", "https", "mailto"]);

/**
 * One of the answer's links: out of Grasp (another host without a
 * protocol, `//host`, too), asked first; else its words alone.
 */
const AnswerLink = ({ link }: { link: MarkdownLink }) =>
  link.kind !== "image" &&
  (leavingSchemes.has(link.scheme) || link.href.startsWith("//")) ? (
    <LeavingLink href={link.href}>{link.children}</LeavingLink>
  ) : (
    <span>{link.children}</span>
  );

/** One answer's words. While it is `writing`, they come in paced. */
export const AnswerWords = ({
  text,
  writing,
  cut = false,
}: {
  text: string;
  writing: boolean;
  /** Stopped part way: a link it was still writing goes, an open mark closes. */
  cut?: boolean;
}) => (
  <Markdown
    renderLink={(link) => <AnswerLink link={link} />}
    cut={cut}
    source={text}
    streaming={writing}
  />
);
