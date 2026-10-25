/**
 * Microsoft's side of the client's Teams bot, as the real connect reaches
 * it behind core in core's tests: Entra issues the bot's token for its
 * secret, and the Bot Connector, on the `serviceUrl` host Teams names,
 * takes activities only with a token Entra issued and reads a
 * conversation's members from its roster. Tests set the roster and read
 * back what was posted.
 *
 * Self-contained, with nothing from outside the function: it runs inside
 * the Worker that stands in for the internet behind connect
 * (test/connect-providers.ts embeds its source).
 */
/** A path's part, as it named it. */
const decoded = (part: string | undefined): string =>
  decodeURIComponent(part ?? "");

export const botConnectorFake = (bot: {
  id: string;
  tenant: string;
  secret: string;
}) => {
  const loginHost = "login.microsoftonline.com";
  const botConnectorHost = "smba.trafficmanager.net";
  const issued = new Set<string>();
  /**
   * Each conversation's activities, as their bodies, in order: each post
   * with the id the Bot Connector gave it, each edit with the id of the
   * activity it replaced (`editOf`).
   */
  const posted: {
    conversation: string;
    activity: unknown;
    id?: string;
    editOf?: string;
  }[] = [];
  /** Conversations where Teams refuses a streamed message. */
  const unstreamed = new Set<string>();
  /**
   * Every roster read, as `<conversation> <user id>`, or `<conversation> *`
   * for a page of the whole roster.
   */
  const asked: string[] = [];
  /** The roster: `<conversation> <user id>` to what Teams says of them. */
  const members: Record<string, unknown> = {};
  /** Conversations the bot was removed from: Teams refuses its posts there. */
  const uninstalled = new Set<string>();

  const membersPath =
    /\/v3\/conversations\/(?<conversation>[^/]+)\/members\/(?<member>[^/]+)$/u;
  const rosterPath =
    /\/v3\/conversations\/(?<conversation>[^/]+)\/pagedMembers$/u;
  /** Members a roster page holds here: small, so tests page through. */
  const rosterPageSize = 2;
  const activitiesPath =
    /\/v3\/conversations\/(?<conversation>[^/]+)\/activities(?:\/[^/]+)?$/u;
  const editPath =
    /\/v3\/conversations\/(?<conversation>[^/]+)\/activities\/(?<activity>[^/]+)$/u;

  const token = async (request: Request): Promise<Response | undefined> => {
    const form = new URLSearchParams(await request.clone().text());
    if (form.get("client_id") !== bot.id) {
      return undefined;
    }
    if (
      form.get("grant_type") !== "client_credentials" ||
      form.get("client_secret") !== bot.secret ||
      form.get("scope") !== "https://api.botframework.com/.default"
    ) {
      return Response.json({ error: "invalid_client" }, { status: 401 });
    }
    const value = `bot-token-${crypto.randomUUID()}`;
    issued.add(value);
    return Response.json({
      token_type: "Bearer",
      expires_in: 3600,
      access_token: value,
    });
  };

  /**
   * Takes a post in `conversation`, unless the bot was taken out of it
   * (`uninstall`) or it is a streamed message where Teams refuses them
   * (`refuseStreams`).
   */
  const post = (conversation: string, body: unknown): Response => {
    if (uninstalled.has(conversation)) {
      return Response.json(
        {
          error: {
            code: "BotNotInConversationRoster",
            message: "The bot is not part of the conversation roster.",
          },
        },
        { status: 403 }
      );
    }
    const streamed = JSON.stringify(body).includes('"streamType":"streaming"');
    if (streamed && unstreamed.has(conversation)) {
      return Response.json(
        { error: { code: "ContentStreamNotAllowed" } },
        { status: 403 }
      );
    }
    const id = `activity-${posted.length + 1}`;
    posted.push({ conversation, activity: body, id });
    return Response.json({ id }, { status: 201 });
  };

  /** One page of `conversation`'s whole roster, from the token `url` names. */
  const rosterPage = (conversation: string, url: URL): Response => {
    asked.push(`${conversation} *`);
    const everyone = Object.entries(members)
      .filter(([key]) => key.startsWith(`${conversation} `))
      .map(([, member]) => member);
    const from = Number(url.searchParams.get("continuationToken") ?? "0");
    const to = from + rosterPageSize;
    return Response.json({
      members: everyone.slice(from, to),
      ...(to < everyone.length ? { continuationToken: String(to) } : {}),
    });
  };

  /** An edit in `conversation` of the activity `editOf`. */
  const edit = (
    conversation: string,
    editOf: string,
    body: unknown
  ): Response => {
    posted.push({ conversation, activity: body, editOf });
    return Response.json({ id: editOf });
  };

  /** One member of a conversation, by `<conversation> <user id>`. */
  const memberOf = (key: string): Response => {
    asked.push(key);
    return Object.hasOwn(members, key)
      ? Response.json(members[key])
      : Response.json({ error: { code: "MemberNotFound" } }, { status: 404 });
  };

  const botConnector = async (request: Request, url: URL) => {
    const bearer = (request.headers.get("authorization") ?? "").replace(
      /^Bearer /u,
      ""
    );
    if (!issued.has(bearer)) {
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }
    const member = membersPath.exec(url.pathname)?.groups;
    if (request.method === "GET" && member !== undefined) {
      return memberOf(
        `${decoded(member.conversation)} ${decoded(member.member)}`
      );
    }
    const roster = rosterPath.exec(url.pathname)?.groups;
    if (request.method === "GET" && roster !== undefined) {
      return rosterPage(decoded(roster.conversation), url);
    }
    const activity = activitiesPath.exec(url.pathname)?.groups;
    if (request.method === "POST" && activity !== undefined) {
      return post(decoded(activity.conversation), await request.json());
    }
    const edited = editPath.exec(url.pathname)?.groups;
    if (request.method === "PUT" && edited !== undefined) {
      return edit(
        decoded(edited.conversation),
        decoded(edited.activity),
        await request.json()
      );
    }
    return Response.json({ error: { code: "NotFound" } }, { status: 404 });
  };

  return {
    posted,
    asked,
    /** Teams refuses streamed messages in `conversation` from now on. */
    refuseStreams: (conversation: string) => {
      unstreamed.add(conversation);
    },
    /** Removes the bot from `conversation`, as uninstalling its app does. */
    uninstall: (conversation: string) => {
      uninstalled.add(conversation);
    },
    /** Adds to the roster, `<conversation> <user id>` to each member. */
    setMembers: (next: Record<string, unknown>) => {
      Object.assign(members, next);
    },
    /** Microsoft's answer to `request`, or undefined when it isn't the bot's. */
    answer: async (request: Request): Promise<Response | undefined> => {
      const url = new URL(request.url);
      if (
        url.hostname === loginHost &&
        request.method === "POST" &&
        url.pathname === `/${bot.tenant}/oauth2/v2.0/token`
      ) {
        return await token(request);
      }
      if (url.hostname === botConnectorHost) {
        return await botConnector(request, url);
      }
      return undefined;
    },
  };
};
