// Whether an Item stands in an ItemGroup, and whether the group draws a hairline between rows.
"use client";

import { createContext } from "react";

export const ItemGroupContext = createContext({
  grouped: false,
  separated: false,
});
