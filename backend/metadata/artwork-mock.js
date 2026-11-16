"use strict";
const { ProviderError } = require("./errors");
// External artwork verification is DISABLED in production. This adapter only serves fixture responses
// so the integration can be developed and tested; it never touches the network. The live variant
// refuses to construct unless MUSICAPP_ARTWORK_VERIFICATION=enabled is set AND an explicit authorisation
// flag is passed -- and no live implementation exists in this branch.
function createArtworkMock(fixtures = {}) {
  return {
    name: "artwork-mock",
    live: false,
    async check(releaseId) {
      const f = fixtures[releaseId];
      if (!f) return { releaseId, status: "unknown", source: "fixture", note: "no fixture" };
      return { releaseId, status: f.status, width: f.width ?? null, height: f.height ?? null, source: "fixture",
        usageNote: "Artwork rights not verified; do not publish without licence confirmation." };
    }
  };
}
function createLiveArtwork(env = process.env) {
  if (env.MUSICAPP_ARTWORK_VERIFICATION !== "enabled") {
    throw new ProviderError("disabled", "external artwork verification is disabled", { provider: "artwork" });
  }
  throw new ProviderError("disabled", "live artwork verification is not implemented in this branch", { provider: "artwork" });
}
module.exports = { createArtworkMock, createLiveArtwork };
