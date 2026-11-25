import { z } from "zod";

import { parse } from "#parse";

export const tool = (name) => ({ name, parse, input: z.object({}) });
