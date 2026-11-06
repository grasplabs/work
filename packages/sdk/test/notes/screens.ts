import { v } from "@grasp-os/sdk";

export default {
  screens: [
    { name: "notes", path: "/", source: "screens/notes.tsx" },
    {
      name: "note",
      path: "/notes/:id",
      source: "screens/note.tsx",
      input: v.object({ id: v.id("notes") }),
    },
  ],
  surfaces: [
    {
      name: "all",
      kind: "sidebar",
      screen: "notes",
      title: "All notes",
      input: v.object({}),
    },
    {
      name: "beside",
      kind: "panel",
      screen: "note",
      title: "Note",
      input: v.object({ id: v.id("notes") }),
    },
    {
      name: "shared",
      kind: "deepLink",
      screen: "note",
      title: "Shared note",
      input: v.object({ id: v.id("notes") }),
    },
  ],
};
