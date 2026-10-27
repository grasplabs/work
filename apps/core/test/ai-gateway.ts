import { z } from "zod";

import { relabelled } from "./drawing-labels.ts";
import { gatewayAnswering } from "./provider-replies.ts";
import type { GatewayReply, GatewayRequest } from "./provider-replies.ts";

export {
  fakeSecondsPerCharacter,
  type Answer,
  type GatewayReply,
  type GatewayRequest,
  type ScriptedToolCall,
} from "./provider-replies.ts";

/**
 * A fake AI binding whose gateway answers each request with what `respond`
 * makes of it, given the requests so far, this one last: at once, or once
 * a provider it asks has answered. A drawing's reply names people by the
 * labels its prompt gave them (`relabelled`). Its `requests` are what
 * reached the gateway.
 */
export const answeringGateway = (
  respond: (
    requests: readonly GatewayRequest[]
  ) => GatewayReply | undefined | Promise<GatewayReply | undefined>
) => gatewayAnswering(respond, relabelled);

/**
 * A fake AI binding whose gateway answers with `replies`, in order. Its
 * `requests` are what reached the gateway.
 */
export const fakeGateway = (...replies: GatewayReply[]) =>
  answeringGateway(() => replies.shift());

/**
 * The run and step a request told the gateway's log it came from
 * (`runId/step`), if it named one.
 */
export const loggedRunStep = ({ headers }: GatewayRequest): unknown =>
  z
    .object({ runStep: z.unknown() })
    .parse(JSON.parse(headers.get("cf-aig-metadata") ?? "{}")).runStep;
