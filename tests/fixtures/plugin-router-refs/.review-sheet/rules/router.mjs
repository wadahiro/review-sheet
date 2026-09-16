// A ROUTER THAT ALSO RESOLVES WHAT A ROW EXPECTS.
//
// Some rows do not hold a product's value at all — they hold the REFERENCE the
// importer was given, `$(env:NAME)`, because that is the one spelling the row
// has across every environment. The product holds what the reference resolved
// to, so comparing the two compares a name with a value and never matches.
//
// The value is already on the sheet: this project records each variable as a
// row of its own. So the table from one to the other is a reading of the model,
// not a second copy of it — and `ctx.items` is the model, as this environment
// resolved it.
import { registerDocumentRouter } from "review-sheet/src/channel.ts";

const REFERENCE = /^\$\(env:([A-Za-z_][A-Za-z0-9_]*)\)$/;

registerDocumentRouter({
  name: "clients-with-refs",
  route: (item, ctx) => {
    if (item.target.sheet !== "clients") return undefined;
    const where = item.address ?? item.target.key;
    // The variable definitions are rows of this sheet too, and they answer to
    // nothing in the document — they are what the document's values came from.
    if (!where.includes(".")) return undefined;

    const named = REFERENCE.exec(item.expected ?? "");
    const defines = named === null ? undefined : (ctx?.items ?? []).find((x) => x.target.key === named[1]);
    return {
      document: "clients",
      address: where,
      // …and nothing when the row expects no reference: leaving it out is how a
      // router says "the row's own expected value stands".
      ...(defines?.expected === undefined ? {} : { expected: defines.expected }),
    };
  },
});
