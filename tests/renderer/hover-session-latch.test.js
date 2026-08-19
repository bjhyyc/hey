import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// A hover session is "cursor resting on the pet's opaque pixels", and playing
// the hover action is part of that session. The tracking condition requires the
// animation state to be "default", so starting the action ended the session and
// cleared the one-shot latch; when the clip finished and the state returned to
// default, the same unmoved cursor started a fresh session and fired the action
// again. The Electron interaction verifier rejected every built PetPack with
// "Hover action repeated without a new opaque hover session".
describe("hover session latch", () => {
  const source = readFileSync(
    new URL("../../src/renderer/pet/pet.js", import.meta.url),
    "utf8"
  );
  const sync = source.slice(
    source.indexOf("function syncHoverDurationWithPixelHit"),
    source.indexOf("function cancelPixelConfirmation")
  );

  it("keeps the latch while the pointer still rests on the pet", () => {
    expect(sync).toContain("if (resetLatch && !nextOpaquePixel) hoverDurationLatch.reset();");
    expect(sync).not.toMatch(/if \(resetLatch\) hoverDurationLatch\.reset\(\);/);
  });

  it("still ends the hover session whenever tracking stops", () => {
    const stopBranch = sync.slice(sync.indexOf("if (!shouldTrackHover"));
    expect(stopBranch).toContain("hoverStartedAt = 0;");
  });

  it("resets the latch on the paths where the pointer genuinely leaves", () => {
    for (const call of [
      'syncHoverDurationWithPixelHit(false, "mouse-leave", { resetLatch: true })',
      'syncHoverDurationWithPixelHit(false, "interactions-paused", { resetLatch: true })'
    ]) {
      expect(source).toContain(call);
    }
  });
});
