// Custom MetadataProvider used by tests/spec-plugins.test.ts to prove
// `import --spec` auto-discovers .review-sheet/providers/. It is the only
// source of descriptions in this fixture, and strict metadata is on, so the
// build fails outright when this module is not loaded.
import { registerMetadataProvider, type MetadataProvider } from "../../../../../src/index.js";

const fixtureDesc: MetadataProvider = {
  name: "fixture-desc",
  priority: 10,
  resolve: (query) => ({
    description: { en: `described by fixture-desc: ${query.key}`, ja: `fixture-desc による説明: ${query.key}` },
    provenance: "community",
  }),
};

registerMetadataProvider(fixtureDesc);
