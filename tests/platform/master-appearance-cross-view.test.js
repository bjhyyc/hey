import { describe, expect, it } from "vitest";

import appearanceModule from "../../platform/src/qa/appearance-lock-v1.js";

const { validateMasterAppearanceInspection } = appearanceModule;

// The appearance block of the 45-degree master that production rejected three
// times in a row for the first paying customer's calico cat (run 22a29911).
// Every left/right verdict is false while every score is above threshold: the
// straight-vs-mirrored comparison was run against the approved front master,
// a different projection of the animal, so it decided nothing.
function crossViewRejection(overrides = {}) {
  return {
    contractVersion: "petpack-appearance-lock/v1",
    referenceBinding: "source-photos-and-approved-front-master",
    sourceReferenceCount: 4,
    fullReferenceCoverage: true,
    occlusionAware: true,
    leftRightAware: true,
    asymmetryPreserved: false,
    speciesAndBreedConsistent: true,
    unresolvedConflictCount: 0,
    faceIdentityScore: 0.7209135939010906,
    coatColorScore: 0.7291644231271645,
    markingTopologyScore: 0.322421960381619,
    regions: {
      head: {
        visible: true,
        faceIdentityScore: 0.7209135939010906,
        coatColorScore: 0.7209135939010906,
        markingTopologyScore: 0.322421960381619,
        leftRightPlacementPreserved: false
      },
      torso: {
        visible: true,
        coatColorScore: 0.5350836577968044,
        markingTopologyScore: 0.322421960381619,
        leftRightPlacementPreserved: false
      },
      legs: {
        visible: true,
        coatColorScore: 0.7128876332308005,
        markingTopologyScore: 0.322421960381619,
        leftRightPlacementPreserved: false
      },
      tail: {
        visible: true,
        coatColorScore: 0.5965668549603190,
        markingTopologyScore: 0.322421960381619,
        leftRightPlacementPreserved: false
      }
    },
    measuredFromDecodedOutput: true,
    evidenceClass: "production",
    ...overrides
  };
}

const policy = {
  minFaceIdentityScore: 0.55,
  minCoatColorScore: 0.28,
  minMarkingTopologyScore: 0.3
};

describe("master appearance left/right placement across views", () => {
  it("passes a side master whose left/right verdict came from a cross-view reference", () => {
    const result = validateMasterAppearanceInspection(crossViewRejection(), {
      kind: "side",
      sourceReferenceCount: 4,
      policy
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("records every skipped left/right verdict as a warning instead of dropping it", () => {
    const result = validateMasterAppearanceInspection(crossViewRejection(), {
      kind: "side",
      sourceReferenceCount: 4,
      policy
    });

    expect(result.warnings).toHaveLength(5);
    for (const warning of result.warnings) {
      expect(warning).toContain("not decidable against this reference");
    }
    expect(result.warnings.some((entry) => entry.includes("asymmetryPreserved"))).toBe(true);
  });

  it("still rejects a front master whose coat was mirrored", () => {
    const result = validateMasterAppearanceInspection(
      crossViewRejection({ referenceBinding: "source-photos" }),
      { kind: "front", sourceReferenceCount: 4, policy }
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Master appearance asymmetryPreserved must be true");
    expect(result.errors).toContain(
      "Master appearance region torso.leftRightPlacementPreserved must be true"
    );
    expect(result.warnings).toEqual([]);
  });

  it("keeps failing a side master on the gates that stay decidable across views", () => {
    const result = validateMasterAppearanceInspection(
      crossViewRejection({ speciesAndBreedConsistent: false, coatColorScore: 0.1 }),
      { kind: "side", sourceReferenceCount: 4, policy }
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Master appearance speciesAndBreedConsistent must be true");
  });
});

describe("master appearance gating by reference trust", () => {
  it("does not fail a master on scores measured against an unmatted photo", () => {
    const result = validateMasterAppearanceInspection(
      crossViewRejection({
        referenceBinding: "source-photos",
        gatingReferenceMode: "photo-background-separated",
        faceIdentityScore: 0.42,
        coatColorScore: 0.19,
        speciesAndBreedConsistent: false,
        unresolvedConflictCount: 2
      }),
      { kind: "front", sourceReferenceCount: 4, policy }
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((entry) => entry.includes("coatColorScore"))).toBe(true);
    expect(result.warnings.some((entry) => entry.includes("speciesAndBreedConsistent"))).toBe(true);
    expect(result.warnings.some((entry) => entry.includes("unresolved source-reference conflicts"))).toBe(true);
  });

  it("still fails a master whose matted reference says it is a different animal", () => {
    const result = validateMasterAppearanceInspection(
      crossViewRejection({
        gatingReferenceMode: "chroma-masked-master",
        coatColorScore: 0.08,
        speciesAndBreedConsistent: false
      }),
      { kind: "side", sourceReferenceCount: 4, policy }
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Master appearance speciesAndBreedConsistent must be true");
    expect(result.errors).toContain("Master appearance.coatColorScore is below the configured threshold");
  });

  it("keeps failing malformed evidence regardless of which reference won", () => {
    const result = validateMasterAppearanceInspection(
      crossViewRejection({
        gatingReferenceMode: "photo-center-window",
        coatColorScore: "not-a-score"
      }),
      { kind: "front", sourceReferenceCount: 4, policy }
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Master appearance.coatColorScore must be a score between 0 and 1");
  });

  it("treats evidence without a recorded gating reference as trusted", () => {
    const result = validateMasterAppearanceInspection(
      crossViewRejection({ referenceBinding: "source-photos", coatColorScore: 0.05 }),
      { kind: "front", sourceReferenceCount: 4, policy }
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Master appearance.coatColorScore is below the configured threshold");
  });
});
