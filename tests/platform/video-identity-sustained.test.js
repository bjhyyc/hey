import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

// Severe identity drift used to be read off the single worst frame. Measured
// over every roll this platform has produced, that frame is noise: clips that
// were delivered dipped as low as 0.027 while holding above the bar for 96% of
// their frames, and the three that had genuinely lost the pet sat below it for
// 13.7% to 25.5%. The gate reads the share of the clip, not the worst frame.

const require = createRequire(import.meta.url);
const { validateVideoAppearanceInspection } = require("../../platform/src/qa/appearance-lock-v1");
const { PRODUCTION_QA_POLICY } = require("../../platform/src/runtime/production-worker-components");

const FRAMES = 145;

function inspection({ belowRatio, minScore = 0.5 }) {
  const regions = {};
  for (const region of ["head", "torso", "legs", "tail"]) {
    regions[region] = {
      visibleFrameCount: FRAMES,
      evaluatedFrameCount: FRAMES,
      ...(region === "head"
        ? { faceIdentityMinScore: minScore, faceIdentityBelowSevereFrameRatio: belowRatio }
        : {}),
      coatColorMinScore: 0.6,
      markingTopologyMinScore: 0.6,
      leftRightPlacementPreserved: true
    };
  }
  return {
    contractVersion: "petpack-appearance-lock/v1",
    referenceBinding: "approved-action-masters",
    fullFrameCoverage: true,
    occlusionAware: true,
    leftRightAware: true,
    asymmetryPreserved: true,
    speciesConsistent: true,
    primaryCoatColorConsistent: true,
    severeIdentityDriftDetected: false,
    sampledFrameCount: FRAMES,
    faceIdentityMinScore: minScore,
    faceIdentityBelowSevereFrameRatio: belowRatio,
    coatColorMinScore: 0.6,
    markingTopologyMinScore: 0.6,
    regions
  };
}

const verdict = (evidence) => validateVideoAppearanceInspection(evidence, {
  production: true,
  sampledFrameCount: FRAMES,
  policy: PRODUCTION_QA_POLICY
});

const driftErrors = (result) => result.errors.filter((error) => error.includes("severe identity drift"));

describe("sustained video identity", () => {
  it("keeps a clip whose worst frame dips but whose body holds", () => {
    // The delivered roll that dipped to 0.027 on one frame of 51.
    const result = verdict(inspection({ belowRatio: 0.039, minScore: 0.027 }));

    expect(driftErrors(result)).toEqual([]);
    expect(result.warnings.join(" ")).toContain("worst frame");
  });

  it("rejects a clip that has lost the pet for a seventh of its length", () => {
    // The three rolls of the stalled order: 13.7%, 13.7%, 25.5%.
    const result = verdict(inspection({ belowRatio: 0.137, minScore: 0.114 }));

    expect(result.ok).toBe(false);
    expect(driftErrors(result).join(" ")).toContain("faceIdentityBelowSevereFrameRatio");
  });

  it("rejects on the head region as well as the whole frame", () => {
    const evidence = inspection({ belowRatio: 0.0 });
    evidence.regions.head.faceIdentityBelowSevereFrameRatio = 0.255;

    expect(driftErrors(verdict(evidence)).join(" ")).toContain("region head");
  });

  it("refuses evidence that does not carry the measure at all", () => {
    const evidence = inspection({ belowRatio: 0.0 });
    delete evidence.faceIdentityBelowSevereFrameRatio;

    const result = verdict(evidence);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("faceIdentityBelowSevereFrameRatio");
  });

  it("draws the line between the two populations it was measured from", () => {
    expect(PRODUCTION_QA_POLICY.maxSevereVideoIdentityFrameRatio).toBeGreaterThan(0.039);
    expect(PRODUCTION_QA_POLICY.maxSevereVideoIdentityFrameRatio).toBeLessThan(0.137);
  });
});
