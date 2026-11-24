// Every finding, team by team, in a sheet the page opens on request, so
// the page itself keeps to one a team.
import { Button } from "@grasp-os/ui/components/button";
import { Heading } from "@grasp-os/ui/components/heading";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@grasp-os/ui/components/sheet";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { findingWords, rowName, say, talkedWords } from "./campaign-words.ts";
import { findingsOf } from "./fixtures.ts";
import type { Campaign } from "./fixtures.ts";

const styles = stylex.create({
  teams: { display: "flex", flexDirection: "column", gap: space[6] },
  team: { display: "flex", flexDirection: "column", gap: space[3] },
  head: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space[3],
  },
  lines: {
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
});

/** Every finding, team by team, in a sheet; the button says how many. */
export const AllFindings = ({ campaign }: { campaign: Campaign }) => {
  const { t, i18n } = useLingui();
  const count = findingsOf(campaign).length;
  if (count === 0) {
    return null;
  }
  const { teams, grouped } = campaign;
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">
          {t`${plural(count, { one: "The one finding", other: "All # findings" })}`}
        </Button>
      </SheetTrigger>
      <SheetContent side="end">
        <SheetHeader>
          <SheetTitle>{t`What we learned`}</SheetTitle>
          <SheetDescription>{t`In our words, never anyone’s own.`}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <div {...stylex.props(styles.teams)}>
            {teams
              .filter((each) => each.findings.length > 0)
              .map((each) => (
                <section key={each.id} {...stylex.props(styles.team)}>
                  {grouped ? (
                    <div {...stylex.props(styles.head)}>
                      <Heading level={3} size="2xs">
                        {say(i18n, rowName(each, grouped))}
                      </Heading>
                      <Text as="span" color="muted">
                        {i18n._(talkedWords(each))}
                      </Text>
                    </div>
                  ) : null}
                  <ul {...stylex.props(styles.lines)}>
                    {each.findings.map((finding) => (
                      <li key={finding.id}>
                        <Text>{say(i18n, findingWords(finding, grouped))}</Text>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
};
