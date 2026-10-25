import { TeamsAdapter } from "@chat-adapter/teams";
import type { TeamsAdapterConfig } from "@chat-adapter/teams";
import type { InternalAxiosRequestConfig } from "axios";
import { z } from "zod";

// Teams' adapter as core builds it (teams.ts): the Chat SDK's, with every
// request Microsoft's SDK under it sends handed to connect.

/**
 * Hands every request a Teams SDK client sends to connect, which sends it
 * on as the client's own bot (connect's src/channels.ts), or refuses it:
 * axios, under the SDK, takes the fetch it sends through from each
 * request's config. Nothing the adapter sends leaves core any other way.
 */
const viaConnect = (env: Env) => ({
  request: ({
    config,
  }: {
    config: InternalAxiosRequestConfig;
  }): InternalAxiosRequestConfig => {
    config.adapter = "fetch";
    config.env = {
      ...config.env,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
        await env.CONNECT.channelFetch("teams", new Request(input, init)),
    };
    return config;
  },
});

/** A member of a conversation, as far as the door reads one. */
const memberSchema = z.object({
  userRole: z.string().optional(),
  tenantId: z.string().optional(),
});
export type TeamsMember = z.infer<typeof memberSchema>;

/** One page of a conversation's roster, as far as the door reads it. */
const rosterPageSchema = z.object({
  members: z.array(memberSchema.extend({ aadObjectId: z.string().optional() })),
  continuationToken: z.string().optional(),
});
type RosterMember = z.infer<typeof rosterPageSchema>["members"][number];

/** Most members a roster page holds: the Bot Connector's own maximum. */
const rosterPageSize = 500;

/**
 * Teams' adapter, sending through connect: Microsoft's SDK builds its
 * clients when the adapter is made, and every client it makes later is a
 * copy of one of these, interceptors and all.
 */
export class ConnectedTeamsAdapter extends TeamsAdapter {
  constructor(env: Env, config: TeamsAdapterConfig) {
    super(config);
    const interceptor = viaConnect(env);
    this.app.client.use(interceptor);
    this.app.api.http.use(interceptor);
    this.app.graph.http.use(interceptor);
  }

  /**
   * What Teams says of `userId` in the conversation: their role (a guest's
   * is `guest`) and their home tenant. Read from the Bot Connector's
   * roster, never from the message.
   */
  async memberOf(
    serviceUrl: string,
    conversationId: string,
    userId: string
  ): Promise<TeamsMember> {
    const member: unknown = await this.app
      .apiFor(serviceUrl)
      .conversations.getMemberById(conversationId, userId);
    return memberSchema.parse(member);
  }

  /**
   * Everyone in the conversation `conversationId`, as Teams' roster says,
   * page by page: `undefined` once it holds more than `atMost`, without
   * reading further.
   */
  async rosterOf(
    serviceUrl: string,
    conversationId: string,
    atMost: number
  ): Promise<RosterMember[] | undefined> {
    const { conversations } = this.app.apiFor(serviceUrl);
    const everyone: RosterMember[] = [];
    let token: string | undefined;
    do {
      // oxlint-disable-next-line no-await-in-loop -- each page names the next
      const page: unknown = await conversations.getPagedMembers(
        conversationId,
        rosterPageSize,
        token
      );
      const { members, continuationToken } = rosterPageSchema.parse(page);
      everyone.push(...members);
      if (everyone.length > atMost) {
        return undefined;
      }
      token = continuationToken === "" ? undefined : continuationToken;
    } while (token !== undefined);
    return everyone;
  }
}
