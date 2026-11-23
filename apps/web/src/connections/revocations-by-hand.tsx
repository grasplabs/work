import { revokeByHandAt } from "@grasp-os/shared/connect";
import type { RevocationToDo } from "@grasp-os/shared/connect";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Link as TextLink } from "@grasp-os/ui/components/link";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Await } from "@tanstack/react-router";
import { Fragment } from "react";

import { formatDate } from "../format.ts";
import type { Loaded } from "../load-from-core.tsx";
import { InfoTip } from "./info-tip.tsx";
import { PartNotLoaded } from "./part-not-loaded.tsx";
import { ProviderMark } from "./provider-mark.tsx";

// Access at an app Grasp couldn't remove itself (GRA-1197): when a
// connection was disconnected, or asked to connect again, connect revokes
// its grant at the provider, trying again until the provider takes it
// (connect's src/revocations.ts). One still refused after about a day, or
// given up, is shown here to the company's admins (and Grasp's staff,
// read-only), with what to do: remove Grasp's access at the app by hand.
// A personal connection is named by its owner, never its account.

const styles = stylex.create({
  // A title and its info mark, on one line.
  titled: { display: "inline-flex", alignItems: "center", gap: space["1"] },
});

/** The place to remove Grasp's access, as words with a link where one exists. */
const WhereToRemove = ({
  toDo,
  app,
}: {
  toDo: RevocationToDo;
  app: string;
}) => {
  const at = revokeByHandAt(toDo.provider);
  const owner = toDo.ownerName ?? "";
  const account = toDo.accountName ?? "";
  const link =
    at === undefined ? null : (
      <TextLink external href={at}>
        {new URL(at).host + new URL(at).pathname}
      </TextLink>
    );
  if (toDo.scope === "shared") {
    return link === null ? (
      <Trans>
        Remove Grasp&apos;s access in {app}&apos;s settings for connected apps,
        signed in as {account}.
      </Trans>
    ) : (
      <Trans>
        Remove Grasp at {link}, signed in as {account}.
      </Trans>
    );
  }
  if (!toDo.ownerIsMember) {
    return (
      <Trans>
        It was a former member&apos;s account: remove Grasp&apos;s access in{" "}
        {app}&apos;s admin settings.
      </Trans>
    );
  }
  return link === null ? (
    <Trans>
      Ask {owner} to remove Grasp&apos;s access in {app}&apos;s settings for
      connected apps.
    </Trans>
  ) : (
    <Trans>
      Ask {owner} to remove Grasp at {link}.
    </Trans>
  );
};

/** Where one revoke stands: still tried, or given up. */
const Standing = ({ toDo }: { toDo: RevocationToDo }) => {
  if (toDo.givenUpAt === null) {
    const tries = toDo.attempts;
    return (
      <Badge variant="warning">
        <Trans>Still trying · {tries} tries</Trans>
      </Badge>
    );
  }
  const date = formatDate(toDo.givenUpAt);
  return (
    <Badge variant="destructive">
      <Trans>Given up {date}</Trans>
    </Badge>
  );
};

const ToDoRow = ({
  toDo,
  nameOf,
}: {
  toDo: RevocationToDo;
  nameOf: (provider: string) => string;
}) => {
  const app = nameOf(toDo.provider);
  const since = formatDate(toDo.since);
  const whose =
    toDo.scope === "shared" ? (toDo.accountName ?? "") : (toDo.ownerName ?? "");
  return (
    <Item size="sm">
      <ItemMedia align="center">
        <ProviderMark id={toDo.provider} logo={null} name={app} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {toDo.scope === "shared" ? (
            <Trans>
              {app}, shared: {whose}
            </Trans>
          ) : (
            <Trans>
              {app}, {whose}&apos;s own
            </Trans>
          )}
        </ItemTitle>
        <ItemDescription>
          {toDo.owedFor === "disconnected" ? (
            <Trans>Disconnected on {since}.</Trans>
          ) : (
            <Trans>Asked to connect again on {since}.</Trans>
          )}{" "}
          <WhereToRemove app={app} toDo={toDo} />
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Standing toDo={toDo} />
      </ItemActions>
    </Item>
  );
};

const ToDoList = ({
  toDos,
  nameOf,
}: {
  toDos: Loaded<RevocationToDo[]>;
  nameOf: (provider: string) => string;
}) => {
  const { t } = useLingui();
  if (toDos.state === "ready" && toDos.data.length === 0) {
    return null;
  }
  return (
    <Card asChild size="sm">
      <section aria-label={t`Access to remove by hand`}>
        <CardHeader>
          <CardTitle level={2}>
            <span {...stylex.props(styles.titled)}>
              {t`Access to remove by hand`}
              {/* Why, behind the info mark: the title says what to do. */}
              <InfoTip label={t`More about access to remove by hand`}>
                {t`Grasp couldn't remove its own access at these apps. Until someone removes it there, it may still work.`}
              </InfoTip>
            </span>
          </CardTitle>
        </CardHeader>
        {toDos.state === "ready" ? (
          <CardContent flush>
            <ItemGroup aria-label={t`Access to remove by hand`}>
              {toDos.data.map((toDo, index) => (
                <Fragment key={toDo.id}>
                  {index > 0 ? <ItemSeparator /> : null}
                  <ToDoRow nameOf={nameOf} toDo={toDo} />
                </Fragment>
              ))}
            </ItemGroup>
          </CardContent>
        ) : (
          <CardContent>
            {/* A failed read is said, never taken for nothing to remove. */}
            <PartNotLoaded page={toDos} />
          </CardContent>
        )}
      </section>
    </Card>
  );
};

/**
 * The revokes to make by hand, for admins and Grasp's staff: nothing at
 * all while there are none, or while they load; why, if they couldn't be
 * read.
 */
export const RevocationsByHand = ({
  toDos,
  nameOf,
}: {
  toDos: Promise<Loaded<RevocationToDo[]>> | undefined;
  nameOf: (provider: string) => string;
}) =>
  toDos === undefined ? null : (
    <Await fallback={null} promise={toDos}>
      {(loaded) => <ToDoList nameOf={nameOf} toDos={loaded} />}
    </Await>
  );
