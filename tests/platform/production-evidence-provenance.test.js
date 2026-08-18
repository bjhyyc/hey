import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { REQUIRED_ACTION_IDS } = require("../../platform/src/domain/action-catalog");
const {
  PRODUCTION_EVIDENCE_CLASS,
  PRODUCTION_EVIDENCE_PROVENANCE_CONTRACT_VERSION,
  REQUIRED_MASTER_KINDS,
  ProductionEvidenceProvenanceError,
  assertProductionEvidenceProvenance,
  validateProductionEvidenceBindings,
  validateProductionEvidenceProvenance,
  validateProductionEvidenceReport
} = require("../../platform/src/qa/production-evidence-provenance");

function digest(character) {
  return character.repeat(64);
}

function report(identityField, identity, seed = "a") {
  return {
    [identityField]: identity,
    ok: true,
    provenance: {
      contractVersion: PRODUCTION_EVIDENCE_PROVENANCE_CONTRACT_VERSION,
      evidenceClass: PRODUCTION_EVIDENCE_CLASS,
      inputSha256: digest(seed),
      outputSha256: digest(seed === "a" ? "b" : "a"),
      processorVersion: `production-${identity}/v1`,
      calibrationDigest: digest("c")
    }
  };
}

function validBundle() {
  return {
    masterReports: Object.fromEntries(
      REQUIRED_MASTER_KINDS.map((kind, index) => [kind, report("kind", kind, index % 2 ? "b" : "a")])
    ),
    actionReports: Object.fromEntries(
      REQUIRED_ACTION_IDS.map((actionId, index) => [actionId, report("actionId", actionId, index % 2 ? "b" : "a")])
    )
  };
}

describe("production evidence provenance", () => {
  it("accepts and freezes complete production provenance for all masters and actions", () => {
    const result = validateProductionEvidenceProvenance(validBundle());

    expect(result).toMatchObject({ ok: true, errors: [] });
    expect(result.evidence.contractVersion).toBe(PRODUCTION_EVIDENCE_PROVENANCE_CONTRACT_VERSION);
    expect(Object.keys(result.evidence.masterReports)).toEqual(REQUIRED_MASTER_KINDS);
    expect(Object.keys(result.evidence.actionReports)).toEqual(REQUIRED_ACTION_IDS);
    expect(result.evidence.actionReports.idle).toMatchObject({
      evidenceClass: "production",
      inputSha256: digest("a"),
      outputSha256: digest("b"),
      processorVersion: "production-idle/v1",
      calibrationDigest: digest("c")
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.evidence.masterReports.front)).toBe(true);
  });

  it.each([
    "internal-controlled-real-staging",
    "controlled-real-staging",
    "development",
    "unknown",
    "",
    undefined
  ])("rejects non-production evidenceClass %s", (evidenceClass) => {
    const bundle = validBundle();
    bundle.masterReports.front.provenance.evidenceClass = evidenceClass;
    bundle.actionReports.idle.provenance.evidenceClass = evidenceClass;

    const result = validateProductionEvidenceProvenance(bundle);

    expect(result.ok).toBe(false);
    expect(result.evidence).toBeNull();
    expect(result.errors).toContain("masterReports.front.provenance.evidenceClass must be production");
    expect(result.errors).toContain("actionReports.idle.provenance.evidenceClass must be production");
  });

  it("requires every canonical report and rejects substituted or unknown IDs", () => {
    const bundle = validBundle();
    delete bundle.masterReports.side;
    delete bundle.actionReports.roll;
    bundle.masterReports.front.kind = "sleep";
    bundle.masterReports.preview = report("kind", "preview");
    bundle.actionReports.wave = report("actionId", "wave");

    const result = validateProductionEvidenceProvenance(bundle);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "masterReports.preview is not a supported report",
      "masterReports.side is required",
      "masterReports.front.kind must be front",
      "actionReports.wave is not a supported report",
      "actionReports.roll is required"
    ]));
  });

  it("requires versioned input, output, processor and calibration bindings on each report", () => {
    const bundle = validBundle();
    bundle.masterReports.front.provenance.inputSha256 = "A".repeat(64);
    bundle.masterReports.side.provenance.outputSha256 = "short";
    bundle.masterReports.sleep.provenance.processorVersion = "contains whitespace";
    bundle.actionReports.idle.provenance.calibrationDigest = null;
    delete bundle.actionReports.sneeze.provenance;
    bundle.actionReports.roll.provenance.contractVersion = "future-unreviewed/v2";

    const result = validateProductionEvidenceProvenance(bundle);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "masterReports.front.provenance.inputSha256 must be a lowercase SHA-256 digest",
      "masterReports.side.provenance.outputSha256 must be a lowercase SHA-256 digest",
      "masterReports.sleep.provenance.processorVersion must be a versioned processor identity",
      "actionReports.idle.provenance.calibrationDigest must be a lowercase SHA-256 digest",
      "actionReports.sneeze.provenance is required",
      "actionReports.roll.provenance.contractVersion is unsupported"
    ]));
  });

  it("throws a typed fail-closed error from the assertion interface", () => {
    const bundle = validBundle();
    bundle.actionReports["sleep-loop"].provenance.evidenceClass = "development";

    let thrown;
    try {
      assertProductionEvidenceProvenance(bundle);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProductionEvidenceProvenanceError);
    expect(thrown).toMatchObject({
      code: "production_evidence_provenance_invalid",
      errors: ["actionReports.sleep-loop.provenance.evidenceClass must be production"]
    });
  });

  it("returns only normalized provenance and does not mistake QA pass state for provenance", () => {
    const bundle = validBundle();
    bundle.masterReports.front.ok = false;
    bundle.masterReports.front.untrustedExtra = { accepted: true };

    const evidence = assertProductionEvidenceProvenance(bundle);

    expect(evidence.masterReports.front).not.toHaveProperty("ok");
    expect(evidence.masterReports.front).not.toHaveProperty("untrustedExtra");
    expect(evidence.masterReports.front.evidenceClass).toBe("production");
  });

  it("validates one report at the generation boundary only in production", () => {
    expect(validateProductionEvidenceReport(null, { production: false })).toMatchObject({ ok: true });
    expect(validateProductionEvidenceReport(report("kind", "front"), { production: true }))
      .toMatchObject({ ok: true, errors: [] });
    expect(validateProductionEvidenceReport(report("actionId", "idle"), { production: true }))
      .toMatchObject({ ok: true, errors: [] });
    expect(validateProductionEvidenceReport(report("kind", "preview"), { production: true }))
      .toMatchObject({ ok: false, errors: ["report.kind is not supported"] });
    expect(validateProductionEvidenceReport({
      ...report("kind", "front"),
      provenance: { ...report("kind", "front").provenance, evidenceClass: "controlled-real-staging" }
    }, { production: true })).toMatchObject({
      ok: false,
      errors: ["report.provenance.evidenceClass must be production"]
    });
  });

  it("binds production evidence to actual input/output bytes and the frozen processor", () => {
    const provenance = report("actionId", "idle").provenance;
    expect(validateProductionEvidenceBindings(provenance, {
      production: true,
      inputSha256: digest("a"),
      outputSha256: digest("b"),
      processorVersion: "production-idle/v1",
      calibrationDigest: digest("c")
    })).toEqual({ ok: true, errors: [] });
    expect(validateProductionEvidenceBindings(provenance, {
      production: true,
      inputSha256: digest("d"),
      outputSha256: digest("e"),
      processorVersion: "replacement/v2",
      calibrationDigest: digest("d")
    })).toMatchObject({ ok: false, errors: expect.arrayContaining([
      "Production evidence input checksum is not bound to the provider artifact",
      "Production evidence output checksum is not bound to the normalized artifact",
      "Production evidence processor version is not bound to the frozen processor",
      "Production evidence calibration digest is not bound to the pinned processor calibration"
    ]) });
    expect(validateProductionEvidenceBindings(null, { production: false })).toEqual({ ok: true, errors: [] });
  });
});
