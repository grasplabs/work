import { tool } from "@grasp-os/sdk/connector";

import { list } from "./list.js";

export const connector = { tools: [tool("items.list"), list] };
