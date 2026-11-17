import { revokeByHandAt } from "@grasp-os/shared/connect";
import type { RevocationToDo } from "@grasp-os/shared/connect";
import { Trans, useLingui } from "@lingui/react/macro";
import { Await } from "@tanstack/react-router";

import { formatDate } from "../format.ts";
import { Badge } from "../grasp/badge/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { Link as TextLink } from "../grasp/link/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { ProviderMark } from "./provider-mark.tsx";

// Access at an app Grasp couldn't remove itself (GRA-1197): when a
// connection was disconnected, or asked to connect again, connect revokes
// its grant at the provider, trying again until the provider takes it
// (connect's src/revocations.ts). One still refused after about a day, or
// given up, is shown here to the company's admins (and Grasp's staff,
// read-only), with what to do: remove Grasp's access at the app by hand.
// A personal connection is named by its owner, never its account.

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
      <Badge tone="attention">
        <Trans>Still trying · {tries} tries</Trans>
      </Badge>
    );
  }
  const date = formatDate(toDo.givenUpAt);
  return (
    <Badge tone="danger">
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
      <ItemMedia>
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
    <SectionCard
      density="compact"
      description={
        toDos.state === "ready"
          ? t`Grasp couldn't remove its own access at these apps. Until someone removes it there, it may still work.`
          : undefined
      }
      flush
      title={t`Access to remove by hand`}
    >
      {toDos.state === "ready" ? (
        <ItemGroup aria-label={t`Access to remove by hand`} separated>
          {toDos.data.map((toDo) => (
            <ToDoRow key={toDo.id} nameOf={nameOf} toDo={toDo} />
          ))}
        </ItemGroup>
      ) : (
        // A failed read is said, never taken for nothing to remove.
        <NotLoaded page={toDos} />
      )}
    </SectionCard>
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
