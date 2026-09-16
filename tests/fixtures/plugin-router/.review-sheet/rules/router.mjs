// A ROUTER THIS PROJECT WROTE. Not a product plugin — a module in this
// project's own probe-rule directory, which is the same directory a project's
// probe rules live in and is loaded by `judge` before anything is judged.
//
// It exists for the case a `document:` template cannot state: one component
// holds several KINDS of document, so the name is not a function of the
// component and the key alone. Here the settings of a store and the list of
// its mappers come back as two documents under one component, and the row's
// own address says which of the two answers it.
import { registerDocumentRouter } from "review-sheet/src/channel.ts";

registerDocumentRouter({
  name: "store-and-mappers",
  route: (item) => {
    if (item.target.sheet !== "directories") return undefined;
    const where = item.address ?? item.target.key;
    if (where.startsWith("mappers[")) {
      return { document: `${item.component}/mappers`, address: where, idFields: ["name"] };
    }
    // A row that is neither is handed BACK rather than filed at a guess.
    if (!where.startsWith("config.")) return undefined;
    return { document: `${item.component}/settings`, address: where };
  },
});
