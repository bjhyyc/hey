import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import chromaModule from "../../platform/src/qa/chroma-subject-integrity.js";
import gateModule from "../../platform/src/qa/action-quality-gate.js";

const { validateChromaSubjectInspection } = chromaModule;
const { resolveActionMotionPolicy } = gateModule;

// The action gate accepts chroma evidence under the action's calibrated motion
// envelope, but the packaging gate re-validated the same evidence under the
// default ceiling (0.12). Every fluffy-fur action that legitimately passed at
// 0.15-0.19 was then rejected at packaging, so a pack could pass all seven
// actions and still never ship. Both gates must apply the same ceiling.
describe("package gate chroma parity", () => {
  const policy = {
    actionMotionEnvelopes: {
      roll: { maxGroundDeltaPx: 32, maxCanvasScaleDelta: 0.65, maxRelativeScaleJitter: 0.65, minAdjacentMaskIoU: 0.6, maxRowSpanHoleRatio: 0.25, minEdgeMarginPx: 16, maxHorizontalOffsetPx: 200 }
    }
  };

  function evidenceWithHoleRatio(rowSpanHoleRatio) {
    return {
      contractVersion: "petpack-chroma-subject-integrity/v1",
      measuredFromDecodedOutput: true,
      fullFrameCoverage: true,
      sampledFrameCount: 145,
      worstFrame: {
        width: 854,
        height: 480,
        boundingBox: { x: 300, y: 200, width: 250, height: 220 },
        componentCount: 1,
        foregroundRatio: 0.08,
        rowSpanHoleRatio,
        largestComponentRatio: 1,
        transparentBorderRatio: 1,
        foregroundGreenSpillRatio: 0,
        significantComponentCount: 1
      }
    };
  }

  it("accepts under the action envelope what the default ceiling rejects", () => {
    const evidence = evidenceWithHoleRatio(0.19);
    const strict = validateChromaSubjectInspection(evidence, { production: true, expectedFrameCount: 145 });
    expect(strict.ok).toBe(false);
    expect(strict.errors.join(" ")).toContain("subject_internal_holes_detected");

    const motion = resolveActionMotionPolicy(policy, "roll", { production: true });
    expect(motion.ok).toBe(true);
    const calibrated = validateChromaSubjectInspection(evidence, {
      production: true,
      expectedFrameCount: 145,
      thresholds: motion.chromaThresholds
    });
    expect(calibrated.ok).toBe(true);
  });

  it("still rejects holes beyond the action's own envelope", () => {
    const motion = resolveActionMotionPolicy(policy, "roll", { production: true });
    const result = validateChromaSubjectInspection(evidenceWithHoleRatio(0.3), {
      production: true,
      expectedFrameCount: 145,
      thresholds: motion.chromaThresholds
    });
    expect(result.ok).toBe(false);
  });

  it("wires the per-action envelope into the packaging assertion", () => {
    const source = readFileSync(
      new URL("../../platform/src/workers/petpack-pipeline-worker.js", import.meta.url),
      "utf8"
    );
    const method = source.slice(source.indexOf("function assertProductionMediaSnapshotEvidence"));
    const actionLoop = method.slice(method.indexOf("for (const actionId of REQUIRED_ACTION_IDS)"));
    expect(actionLoop).toContain("resolveActionMotionPolicy(policy, actionId");
    expect(actionLoop).toContain("thresholds: actionMotion.chromaThresholds");
  });

  it("requires a policy provider before production packaging starts", () => {
    const source = readFileSync(
      new URL("../../platform/src/workers/petpack-pipeline-worker.js", import.meta.url),
      "utf8"
    );
    expect(source).toContain('requireMethod(qaPolicyProvider, "getPolicy", "Production PetPack QA policy provider")');
  });
});
