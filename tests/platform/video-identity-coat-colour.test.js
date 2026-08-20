import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

// Severe identity drift was read off faceIdentityMinScore, which recognises no
// face: it compares the colour of the top 38% band of the subject's bounding
// box against the master's. A dog that lies down and rolls takes its head out
// of that band - coverage measured as low as 0.004 - and an empty band scores
// near zero, so sound video was rejected for the dog being off its feet. What
// rejects a clip now is the colour of the whole subject, which survives any
// orientation.

const require = createRequire(import.meta.url);
const { validateVideoAppearanceInspection } = require("../../platform/src/qa/appearance-lock-v1");
const { PRODUCTION_QA_POLICY } = require("../../platform/src/runtime/production-worker-components");

const FRAMES = 145;

function inspection({ coat, head = 0.5, regionCoat = null }) {
  const regions = {};
  for (const region of ["head", "torso", "legs", "tail"]) {
    regions[region] = {
      visibleFrameCount: FRAMES,
      evaluatedFrameCount: FRAMES,
      ...(region === "head" ? { faceIdentityMinScore: head } : {}),
      coatColorMinScore: regionCoat ?? coat,
      markingTopologyMinScore: 0.4,
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
    faceIdentityMinScore: head,
    coatColorMinScore: coat,
    markingTopologyMinScore: 0.4,
    regions
  };
}

const verdict = (evidence) => validateVideoAppearanceInspection(evidence, {
  production: true,
  sampledFrameCount: FRAMES,
  policy: PRODUCTION_QA_POLICY
});

const driftErrors = (result) => result.errors.filter((error) => error.includes("severe identity drift"));

describe("video identity by coat colour", () => {
  it("keeps a rolling dog whose head leaves the top band", () => {
    // The corgi roll the owner looked at and found nothing wrong with: the band
    // score collapsed to 0.059 while the whole subject held at 0.5056.
    const result = verdict(inspection({ coat: 0.5056, head: 0.0594 }));

    expect(driftErrors(result)).toEqual([]);
    expect(result.warnings.join(" ")).toContain("head-band colour");
  });

  it("rejects a subject whose colour has genuinely gone", () => {
    const result = verdict(inspection({ coat: 0.12, head: 0.2 }));

    expect(result.ok).toBe(false);
    expect(driftErrors(result).join(" ")).toContain("coatColorMinScore");
  });

  it("leaves every clip that has ever been delivered alone", () => {
    // The 53 videos that passed floor at 0.4423 on the whole subject.
    expect(PRODUCTION_QA_POLICY.minSevereVideoCoatColorScore).toBeLessThan(0.4423);
  });

  it("never rejects on a band measure, whichever region it belongs to", () => {
    // Region scores are measured on positional bands too, so they move with
    // orientation rather than identity and must not be able to fail a clip.
    const evidence = inspection({ coat: 0.6, head: 0.01, regionCoat: 0.02 });

    expect(driftErrors(verdict(evidence))).toEqual([]);
  });
});
