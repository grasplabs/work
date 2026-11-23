import { isMemberAdmin } from "@grasp-os/shared/roles";
import { Card, CardContent } from "@grasp-os/ui/components/card";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGrid,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { SectionHeader } from "@grasp-os/ui/components/section-header";
import { Sheet, SheetContent, SheetTitle } from "@grasp-os/ui/components/sheet";
import {
  SidePanel,
  SidePanelContent,
  SidePanelHeader,
} from "@grasp-os/ui/components/side-panel";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  useNavigate,
  useRouteContext,
  useSearch,
} from "@tanstack/react-router";

import { Page } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";

// The Integrations pages before they arrive, built from the parts they
// will show, so nothing moves when they do: the overview's header, its
// slim band and runs of tiles in the real ItemGrid with Items in an app
// tile's shape (`loading` Items wait as their own boxes); an app's panel
// over it, when the address opens one (`?app=`), on SidePanel's own
// `loading`; and an app's own page, its head and one account's row.

const styles = stylex.create({
  page: { display: "grid", gap: space["8"], minWidth: 0 },
  run: { display: "grid", gap: space["4"], minWidth: 0 },
  bandWords: { display: "grid", gap: space["2"], width: "min(100%, 24rem)" },
  column: {
    display: "grid",
    gap: space["8"],
    width: "100%",
    maxWidth: "40rem",
    marginInline: "auto",
    minWidth: 0,
  },
  fill: { display: "flex", flexDirection: "column", height: "100%" },
});

/** A run of tiles waiting, `tiles` of them under a heading. */
const Run = ({ tiles }: { tiles: number }) => (
  <div {...stylex.props(styles.run)}>
    <SectionHeader headingLevel={2} loading size="sm" title="" />
    <ItemGrid>
      {Array.from({ length: tiles }, (_, index) => (
        <Item key={index} loading size="xs" variant="outline">
          <ItemMedia align="center" />
          <ItemContent>
            <ItemTitle />
            <ItemDescription />
          </ItemContent>
        </Item>
      ))}
    </ItemGrid>
  </div>
);

/** The overview, waiting, and the panel of the app the address names. */
export const IntegrationsSkeleton = () => {
  const { t } = useLingui();
  const { app, group, q } = useSearch({ strict: false });
  // The overview shows the slim band, then Recommended, Connected and a kind.
  const overview = group === undefined && q === undefined;
  const navigate = useNavigate({ from: "/integrations/" });
  const close = (): void => {
    void navigate({
      search: (last) => ({ ...last, app: undefined }),
    });
  };
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Integrations` }]} />
      <Page>
        <output
          aria-busy="true"
          aria-label={t`Loading integrations`}
          {...stylex.props(styles.page)}
        >
          <PageHeader loading title="" />
          {overview ? (
            <Card padding="lg">
              <div {...stylex.props(styles.bandWords)}>
                <Skeleton size="lg" />
                <Skeleton size="sm" />
              </div>
            </Card>
          ) : null}
          <Run tiles={overview ? 3 : 8} />
          {overview ? <Run tiles={4} /> : null}
        </output>
      </Page>
      {app === undefined ? null : (
        <Sheet
          onOpenChange={(open) => {
            if (!open) {
              close();
            }
          }}
          open
        >
          <SheetContent showCloseButton={false}>
            <span {...stylex.props(visuallyHidden)}>
              <SheetTitle>{t`Loading the app`}</SheetTitle>
            </span>
            <div {...stylex.props(styles.fill)}>
              <SidePanel aria-label={t`Loading the app`} framed={false}>
                <SidePanelHeader
                  description=""
                  loading
                  onClose={close}
                  title=""
                />
                <SidePanelContent>
                  <ItemGroup>
                    <Item loading size="xs">
                      <ItemContent>
                        <ItemTitle />
                      </ItemContent>
                    </Item>
                  </ItemGroup>
                </SidePanelContent>
              </SidePanel>
            </div>
          </SheetContent>
        </Sheet>
      )}
    </>
  );
};

/**
 * An app's own page, waiting, as its page stands: its head and one
 * account's row, and, for the organization's admins, whether it is
 * offered.
 */
export const IntegrationSkeleton = () => {
  const { t } = useLingui();
  const { identity } = useRouteContext({ from: "/_shell" });
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Integrations`, to: "/integrations" }]} />
      <Page>
        <output
          aria-busy="true"
          aria-label={t`Loading the app`}
          {...stylex.props(styles.column)}
        >
          <Card padding="lg" size="sm">
            <Item loading>
              <ItemMedia align="center" />
              <ItemContent>
                <ItemTitle />
                <ItemDescription />
              </ItemContent>
            </Item>
          </Card>
          {isMemberAdmin(identity) ? <Skeleton /> : null}
          <Card size="sm">
            <CardContent flush>
              <ItemGroup>
                <Item loading size="xs">
                  <ItemContent>
                    <ItemTitle />
                    <ItemDescription />
                  </ItemContent>
                </Item>
              </ItemGroup>
            </CardContent>
          </Card>
        </output>
      </Page>
    </>
  );
};
