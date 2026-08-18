"use strict";

const { REQUIRED_ACTION_IDS } = require("../domain/action-catalog");

const PRODUCTION_EVIDENCE_PROVENANCE_CONTRACT_VERSION = "petpack-production-evidence-provenance/v1";
const PRODUCTION_EVIDENCE_CLASS = "production";
const REQUIRED_MASTER_KINDS = Object.freeze(["front", "side", "sleep"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROCESSOR_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateSha256(value, path, errors) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    errors.push(`${path} must be a lowercase SHA-256 digest`);
    return null;
  }
  return value;
}

function validateProcessorVersion(value, path, errors) {
  if (typeof value !== "string" || !PROCESSOR_VERSION_PATTERN.test(value)) {
    errors.push(`${path} must be a versioned processor identity`);
    return null;
  }
  return value;
}

function validateReport(report, { path, identityField, expectedIdentity }, errors) {
  const initialErrorCount = errors.length;
  if (!isRecord(report)) {
    errors.push(`${path} must be a QA report object`);
    return null;
  }
  if (report[identityField] !== expectedIdentity) {
    errors.push(`${path}.${identityField} must be ${expectedIdentity}`);
  }

  const provenance = report.provenance;
  if (!isRecord(provenance)) {
    errors.push(`${path}.provenance is required`);
    return null;
  }
  if (provenance.contractVersion !== PRODUCTION_EVIDENCE_PROVENANCE_CONTRACT_VERSION) {
    errors.push(`${path}.provenance.contractVersion is unsupported`);
  }
  if (provenance.evidenceClass !== PRODUCTION_EVIDENCE_CLASS) {
    errors.push(`${path}.provenance.evidenceClass must be production`);
  }

  const inputSha256 = validateSha256(
    provenance.inputSha256,
    `${path}.provenance.inputSha256`,
    errors
  );
  const outputSha256 = validateSha256(
    provenance.outputSha256,
    `${path}.provenance.outputSha256`,
    errors
  );
  const processorVersion = validateProcessorVersion(
    provenance.processorVersion,
    `${path}.provenance.processorVersion`,
    errors
  );
  const calibrationDigest = validateSha256(
    provenance.calibrationDigest,
    `${path}.provenance.calibrationDigest`,
    errors
  );

  if (errors.length !== initialErrorCount) return null;
  return Object.freeze({
    contractVersion: PRODUCTION_EVIDENCE_PROVENANCE_CONTRACT_VERSION,
    evidenceClass: PRODUCTION_EVIDENCE_CLASS,
    inputSha256,
    outputSha256,
    processorVersion,
    calibrationDigest
  });
}

function validateReportCollection(value, {
  path,
  requiredIds,
  identityField
}, errors) {
  const normalized = {};
  if (!isRecord(value)) {
    errors.push(`${path} must be an object keyed by required report ID`);
    return normalized;
  }

  for (const key of Object.keys(value)) {
    if (!requiredIds.includes(key)) errors.push(`${path}.${key} is not a supported report`);
  }
  for (const expectedIdentity of requiredIds) {
    if (!hasOwn(value, expectedIdentity)) {
      errors.push(`${path}.${expectedIdentity} is required`);
      continue;
    }
    const report = validateReport(value[expectedIdentity], {
      path: `${path}.${expectedIdentity}`,
      identityField,
      expectedIdentity
    }, errors);
    if (report) normalized[expectedIdentity] = report;
  }
  return normalized;
}

/**
 * Validates provenance only. Existing QA gates remain responsible for the
 * report's pass/fail decision; this gate proves that every required report was
 * produced by an explicitly production-classified, versioned and calibrated
 * processor over named input/output bytes.
 */
function validateProductionEvidenceProvenance({ masterReports, actionReports } = {}) {
  const errors = [];
  const masters = validateReportCollection(masterReports, {
    path: "masterReports",
    requiredIds: REQUIRED_MASTER_KINDS,
    identityField: "kind"
  }, errors);
  const actions = validateReportCollection(actionReports, {
    path: "actionReports",
    requiredIds: REQUIRED_ACTION_IDS,
    identityField: "actionId"
  }, errors);
  const ok = errors.length === 0;
  const evidence = ok
    ? Object.freeze({
        contractVersion: PRODUCTION_EVIDENCE_PROVENANCE_CONTRACT_VERSION,
        evidenceClass: PRODUCTION_EVIDENCE_CLASS,
        masterReports: Object.freeze(masters),
        actionReports: Object.freeze(actions)
      })
    : null;
  return Object.freeze({ ok, errors: Object.freeze(errors), evidence });
}

function validateProductionEvidenceReport(report, { production = false } = {}) {
  if (!production) return Object.freeze({ ok: true, errors: Object.freeze([]), evidence: null });
  const errors = [];
  const hasKind = isRecord(report) && hasOwn(report, "kind");
  const hasActionId = isRecord(report) && hasOwn(report, "actionId");
  if (hasKind === hasActionId) {
    return Object.freeze({
      ok: false,
      errors: Object.freeze(["Production evidence report must identify exactly one master kind or action ID"]),
      evidence: null
    });
  }
  const identityField = hasKind ? "kind" : "actionId";
  const expectedIdentity = report[identityField];
  const supported = hasKind ? REQUIRED_MASTER_KINDS : REQUIRED_ACTION_IDS;
  if (!supported.includes(expectedIdentity)) {
    errors.push(`report.${identityField} is not supported`);
  }
  const evidence = validateReport(report, {
    path: "report",
    identityField,
    expectedIdentity
  }, errors);
  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    evidence: errors.length === 0 ? evidence : null
  });
}

function validateProductionEvidenceBindings(provenance, {
  production = false,
  inputSha256,
  outputSha256,
  processorVersion,
  calibrationDigest
} = {}) {
  if (!production) return Object.freeze({ ok: true, errors: Object.freeze([]) });
  const errors = [];
  if (!isRecord(provenance)) {
    errors.push("Production evidence provenance is required for artifact binding");
  } else {
    if (provenance.inputSha256 !== inputSha256) errors.push("Production evidence input checksum is not bound to the provider artifact");
    if (provenance.outputSha256 !== outputSha256) errors.push("Production evidence output checksum is not bound to the normalized artifact");
    if (provenance.processorVersion !== processorVersion) errors.push("Production evidence processor version is not bound to the frozen processor");
    if (provenance.calibrationDigest !== calibrationDigest) {
      errors.push("Production evidence calibration digest is not bound to the pinned processor calibration");
    }
  }
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
}

class ProductionEvidenceProvenanceError extends Error {
  constructor(errors) {
    super("Production evidence provenance is invalid");
    this.name = "ProductionEvidenceProvenanceError";
    this.code = "production_evidence_provenance_invalid";
    this.errors = Object.freeze([...(Array.isArray(errors) ? errors : [])]);
  }
}

function assertProductionEvidenceProvenance(input) {
  const result = validateProductionEvidenceProvenance(input);
  if (!result.ok) throw new ProductionEvidenceProvenanceError(result.errors);
  return result.evidence;
}

module.exports = {
  PRODUCTION_EVIDENCE_CLASS,
  PRODUCTION_EVIDENCE_PROVENANCE_CONTRACT_VERSION,
  REQUIRED_MASTER_KINDS,
  ProductionEvidenceProvenanceError,
  assertProductionEvidenceProvenance,
  validateProductionEvidenceBindings,
  validateProductionEvidenceProvenance,
  validateProductionEvidenceReport
};
