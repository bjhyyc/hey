"use strict";

const SUBJECT_APPEARANCE_CONTRACT_VERSION = "petpack-subject-appearance-metrics/v1";

// Deterministic pixel measurements over decoded RGBA frames. Every score in
// this module is a pure function of the supplied bytes and the frozen
// calibration options: color distribution similarity, spatial marking-layout
// similarity, and calibrated canonical-geometry estimates. There is no model
// inference and no fixture value; thresholds interpreting these measurements
// live in the pinned production QA policy and calibration, not here.
const DEFAULT_APPEARANCE_OPTIONS = Object.freeze({
  alphaThreshold: 32,
  histogramBinsPerChannel: 8,
  markingGridSize: 8,
  minRegionCoverage: 0.08,
  minMarkingCellCoverage: 0.05,
  regionBands: Object.freeze({ head: 0.38, legs: 0.28, tail: 0.2 })
});

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${label} must be a positive integer`);
  return parsed;
}

function normalizeAppearanceOptions(overrides = {}) {
  const options = { ...DEFAULT_APPEARANCE_OPTIONS, ...overrides };
  options.alphaThreshold = positiveInteger(options.alphaThreshold, "alphaThreshold");
  if (options.alphaThreshold > 255) throw new TypeError("alphaThreshold is outside its allowed range");
  options.histogramBinsPerChannel = positiveInteger(options.histogramBinsPerChannel, "histogramBinsPerChannel");
  if (options.histogramBinsPerChannel > 16) throw new TypeError("histogramBinsPerChannel is outside its allowed range");
  options.markingGridSize = positiveInteger(options.markingGridSize, "markingGridSize");
  if (options.markingGridSize > 32) throw new TypeError("markingGridSize is outside its allowed range");
  for (const key of ["minRegionCoverage", "minMarkingCellCoverage"]) {
    const parsed = Number(options[key]);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) throw new TypeError(`${key} must be between zero and one`);
    options[key] = parsed;
  }
  const bands = options.regionBands || {};
  const head = Number(bands.head);
  const legs = Number(bands.legs);
  const tail = Number(bands.tail);
  if (![head, legs, tail].every((value) => Number.isFinite(value) && value > 0 && value < 1) || head + legs >= 1) {
    throw new TypeError("regionBands must partition the subject bounding box");
  }
  options.regionBands = Object.freeze({ head, legs, tail });
  return Object.freeze(options);
}

function emptyHistogram(binsPerChannel) {
  return new Float64Array(binsPerChannel * binsPerChannel * binsPerChannel);
}

function normalizeHistogram(histogram, total) {
  if (total <= 0) return histogram;
  for (let index = 0; index < histogram.length; index += 1) histogram[index] /= total;
  return histogram;
}

/**
 * Measures one RGBA frame: subject mask statistics, whole-subject and
 * per-region color histograms, and a coarse spatial marking grid over the
 * subject bounding box. Regions are deterministic geometric bands of the
 * bounding box (head = top band, legs = bottom band, tail = trailing column
 * band); they are proxies for anatomy and are always compared like-for-like
 * against the same band of the reference subject.
 */
function measureSubjectFrame(bytes, { width, height, options: optionOverrides } = {}) {
  const normalizedWidth = positiveInteger(width, "Frame width");
  const normalizedHeight = positiveInteger(height, "Frame height");
  const options = normalizeAppearanceOptions(optionOverrides);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new TypeError("RGBA frame bytes are required");
  }
  if (bytes.length !== normalizedWidth * normalizedHeight * 4) {
    throw new TypeError("RGBA frame byte size does not match its dimensions");
  }

  const bins = options.histogramBinsPerChannel;
  const binShift = Math.ceil(Math.log2(256 / bins));
  let foregroundPixels = 0;
  let centroidX = 0;
  let centroidY = 0;
  let minX = normalizedWidth;
  let minY = normalizedHeight;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < normalizedHeight; y += 1) {
    const rowOffset = y * normalizedWidth;
    for (let x = 0; x < normalizedWidth; x += 1) {
      if (bytes[(rowOffset + x) * 4 + 3] < options.alphaThreshold) continue;
      foregroundPixels += 1;
      centroidX += x;
      centroidY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (foregroundPixels === 0) {
    return Object.freeze({
      contractVersion: SUBJECT_APPEARANCE_CONTRACT_VERSION,
      width: normalizedWidth,
      height: normalizedHeight,
      options,
      foregroundPixels: 0,
      boundingBox: null,
      centroid: null,
      histogram: emptyHistogram(bins),
      regions: null,
      markingGrid: null
    });
  }

  const boundingBox = { left: minX, top: minY, right: maxX, bottom: maxY };
  const boxWidth = maxX - minX + 1;
  const boxHeight = maxY - minY + 1;
  const bands = options.regionBands;
  const headRowLimit = minY + Math.max(1, Math.round(boxHeight * bands.head));
  const legsRowStart = maxY - Math.max(1, Math.round(boxHeight * bands.legs)) + 1;
  const tailColumnStart = maxX - Math.max(1, Math.round(boxWidth * bands.tail)) + 1;
  const gridSize = options.markingGridSize;

  const histogram = emptyHistogram(bins);
  const regionNames = ["head", "torso", "legs", "tail"];
  const regionHistograms = {
    head: emptyHistogram(bins),
    torso: emptyHistogram(bins),
    legs: emptyHistogram(bins),
    tail: emptyHistogram(bins)
  };
  const regionPixels = { head: 0, torso: 0, legs: 0, tail: 0 };
  const regionArea = { head: 0, torso: 0, legs: 0, tail: 0 };
  const cellCount = gridSize * gridSize;
  const cellSums = new Float64Array(cellCount * 3);
  const cellPixels = new Float64Array(cellCount);
  const cellArea = new Float64Array(cellCount);

  for (let y = minY; y <= maxY; y += 1) {
    const rowOffset = y * normalizedWidth;
    const gridRow = Math.min(gridSize - 1, Math.floor(((y - minY) * gridSize) / boxHeight));
    const rowRegion = y < headRowLimit ? "head" : y >= legsRowStart ? "legs" : "torso";
    for (let x = minX; x <= maxX; x += 1) {
      const cellIndex = gridRow * gridSize + Math.min(gridSize - 1, Math.floor(((x - minX) * gridSize) / boxWidth));
      cellArea[cellIndex] += 1;
      regionArea[rowRegion] += 1;
      if (x >= tailColumnStart) regionArea.tail += 1;
      const byteIndex = (rowOffset + x) * 4;
      if (bytes[byteIndex + 3] < options.alphaThreshold) continue;
      const red = bytes[byteIndex];
      const green = bytes[byteIndex + 1];
      const blue = bytes[byteIndex + 2];
      const binIndex = ((red >> binShift) * bins + (green >> binShift)) * bins + (blue >> binShift);
      histogram[binIndex] += 1;
      regionHistograms[rowRegion][binIndex] += 1;
      regionPixels[rowRegion] += 1;
      if (x >= tailColumnStart) {
        regionHistograms.tail[binIndex] += 1;
        regionPixels.tail += 1;
      }
      cellSums[cellIndex * 3] += red;
      cellSums[cellIndex * 3 + 1] += green;
      cellSums[cellIndex * 3 + 2] += blue;
      cellPixels[cellIndex] += 1;
    }
  }

  normalizeHistogram(histogram, foregroundPixels);
  const regions = {};
  for (const region of regionNames) {
    normalizeHistogram(regionHistograms[region], regionPixels[region]);
    regions[region] = Object.freeze({
      pixels: regionPixels[region],
      coverage: regionPixels[region] / Math.max(1, regionArea[region]),
      histogram: regionHistograms[region]
    });
  }
  const markingGrid = { size: gridSize, coverage: new Float64Array(cellCount), color: new Float64Array(cellCount * 3) };
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
    markingGrid.coverage[cellIndex] = cellPixels[cellIndex] / Math.max(1, cellArea[cellIndex]);
    if (cellPixels[cellIndex] > 0) {
      markingGrid.color[cellIndex * 3] = cellSums[cellIndex * 3] / cellPixels[cellIndex];
      markingGrid.color[cellIndex * 3 + 1] = cellSums[cellIndex * 3 + 1] / cellPixels[cellIndex];
      markingGrid.color[cellIndex * 3 + 2] = cellSums[cellIndex * 3 + 2] / cellPixels[cellIndex];
    }
  }

  return Object.freeze({
    contractVersion: SUBJECT_APPEARANCE_CONTRACT_VERSION,
    width: normalizedWidth,
    height: normalizedHeight,
    options,
    foregroundPixels,
    boundingBox: Object.freeze(boundingBox),
    centroid: Object.freeze({ x: centroidX / foregroundPixels, y: centroidY / foregroundPixels }),
    histogram,
    regions: Object.freeze(regions),
    markingGrid: Object.freeze(markingGrid)
  });
}

function compareColorHistograms(first, second) {
  if (!(first instanceof Float64Array) || !(second instanceof Float64Array) || first.length !== second.length) {
    throw new TypeError("Comparable normalized color histograms are required");
  }
  let intersection = 0;
  let firstTotal = 0;
  let secondTotal = 0;
  for (let index = 0; index < first.length; index += 1) {
    intersection += Math.min(first[index], second[index]);
    firstTotal += first[index];
    secondTotal += second[index];
  }
  if (firstTotal <= 0 || secondTotal <= 0) return 0;
  return intersection;
}

function compareMarkingGrids(first, second, { minMarkingCellCoverage = DEFAULT_APPEARANCE_OPTIONS.minMarkingCellCoverage } = {}) {
  if (!first || !second || first.size !== second.size) {
    throw new TypeError("Comparable subject marking grids are required");
  }
  const cellCount = first.size * first.size;
  let comparableCells = 0;
  let score = 0;
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
    const firstCoverage = first.coverage[cellIndex];
    const secondCoverage = second.coverage[cellIndex];
    if (Math.max(firstCoverage, secondCoverage) < minMarkingCellCoverage) continue;
    comparableCells += 1;
    const coverageSimilarity = 1 - Math.abs(firstCoverage - secondCoverage);
    let colorDelta = 0;
    if (firstCoverage >= minMarkingCellCoverage && secondCoverage >= minMarkingCellCoverage) {
      for (let channel = 0; channel < 3; channel += 1) {
        colorDelta += Math.abs(first.color[cellIndex * 3 + channel] - second.color[cellIndex * 3 + channel]);
      }
      colorDelta /= 3 * 255;
    } else {
      colorDelta = 1;
    }
    score += Math.max(0, coverageSimilarity * (1 - colorDelta));
  }
  if (comparableCells === 0) return 0;
  return score / comparableCells;
}

/**
 * Left/right marking-placement check: straight (left-vs-left, right-vs-right)
 * grid similarity must not lose to the mirrored pairing, otherwise a marking
 * moved sides between the reference subject and the candidate subject.
 */
function isLeftRightPlacementPreserved(first, second, { tolerance = 0.05, minMarkingCellCoverage } = {}) {
  if (!first || !second || first.size !== second.size) {
    throw new TypeError("Comparable subject marking grids are required");
  }
  const size = first.size;
  const half = (grid, side) => {
    const columns = side === "left"
      ? { start: 0, end: Math.floor(size / 2) }
      : { start: Math.ceil(size / 2), end: size };
    const width = columns.end - columns.start;
    const coverage = new Float64Array(size * width);
    const color = new Float64Array(size * width * 3);
    for (let row = 0; row < size; row += 1) {
      for (let column = columns.start; column < columns.end; column += 1) {
        const from = row * size + column;
        // Mirror the right half so both halves share one column orientation
        // and a straight comparison is geometrically aligned.
        const localColumn = side === "left" ? column - columns.start : columns.end - 1 - column;
        const to = row * width + localColumn;
        coverage[to] = grid.coverage[from];
        for (let channel = 0; channel < 3; channel += 1) color[to * 3 + channel] = grid.color[from * 3 + channel];
      }
    }
    return { size: Math.sqrt(size * width) > 0 ? size : size, rows: size, width, coverage, color };
  };
  const compareHalves = (a, b) => {
    const cells = a.coverage.length;
    let comparable = 0;
    let score = 0;
    const floor = Number.isFinite(Number(minMarkingCellCoverage))
      ? Number(minMarkingCellCoverage)
      : DEFAULT_APPEARANCE_OPTIONS.minMarkingCellCoverage;
    for (let index = 0; index < cells; index += 1) {
      if (Math.max(a.coverage[index], b.coverage[index]) < floor) continue;
      comparable += 1;
      let colorDelta = 1;
      if (a.coverage[index] >= floor && b.coverage[index] >= floor) {
        colorDelta = 0;
        for (let channel = 0; channel < 3; channel += 1) {
          colorDelta += Math.abs(a.color[index * 3 + channel] - b.color[index * 3 + channel]);
        }
        colorDelta /= 3 * 255;
      }
      score += Math.max(0, (1 - Math.abs(a.coverage[index] - b.coverage[index])) * (1 - colorDelta));
    }
    return comparable === 0 ? 0 : score / comparable;
  };
  const firstLeft = half(first, "left");
  const firstRight = half(first, "right");
  const secondLeft = half(second, "left");
  const secondRight = half(second, "right");
  const straight = (compareHalves(firstLeft, secondLeft) + compareHalves(firstRight, secondRight)) / 2;
  const crossed = (compareHalves(firstLeft, secondRight) + compareHalves(firstRight, secondLeft)) / 2;
  return straight + tolerance >= crossed;
}

/**
 * Calibrated apparent-scale estimate over the subject bounding box. The square
 * root of bounding-box area is stable when a subject turns, lies down or rolls,
 * while still changing linearly when the whole character is resized. Unlike
 * foreground-pixel area it is not reduced by fine fur or small keying holes.
 * The legacy torso/head/shoulder field names are retained by the QA contract;
 * their calibrated ratios are three projections of this one pose-tolerant
 * scale signal, while appearance and decoded endpoint gates carry anatomy.
 */
function estimateCanonicalGeometry(measurement, ratios) {
  if (!measurement || !measurement.boundingBox || !(measurement.foregroundPixels > 0)) {
    throw new TypeError("A subject measurement with a visible subject is required");
  }
  for (const key of ["torsoRatio", "headRatio", "shoulderRatio"]) {
    const parsed = Number(ratios?.[key]);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 4) {
      throw new TypeError(`Calibrated geometry ${key} is required`);
    }
  }
  const box = measurement.boundingBox;
  const apparentScale = Math.sqrt((box.right - box.left + 1) * (box.bottom - box.top + 1));
  return Object.freeze({
    visibleBounds: Object.freeze({ left: box.left, top: box.top, right: box.right, bottom: box.bottom }),
    groundBaselineY: box.bottom,
    centerX: measurement.centroid.x,
    torsoHeightPx: apparentScale * Number(ratios.torsoRatio),
    headHeightPx: apparentScale * Number(ratios.headRatio),
    shoulderWidthPx: apparentScale * Number(ratios.shoulderRatio)
  });
}

/**
 * Scores a candidate subject against one reference subject measurement.
 * Face-identity is the head-band comparison; it is a calibrated color/layout
 * proxy for identity, not a biometric face model, and is documented as such in
 * the production evidence.
 */
function compareSubjectAppearance(candidate, reference) {
  if (!candidate?.regions || !reference?.regions || !candidate.markingGrid || !reference.markingGrid) {
    throw new TypeError("Comparable subject measurements are required");
  }
  const options = candidate.options || DEFAULT_APPEARANCE_OPTIONS;
  const coatColorScore = compareColorHistograms(candidate.histogram, reference.histogram);
  const markingTopologyScore = compareMarkingGrids(candidate.markingGrid, reference.markingGrid, options);
  const faceIdentityScore = compareColorHistograms(candidate.regions.head.histogram, reference.regions.head.histogram);
  const regions = {};
  for (const region of ["head", "torso", "legs", "tail"]) {
    regions[region] = Object.freeze({
      coatColorScore: compareColorHistograms(candidate.regions[region].histogram, reference.regions[region].histogram),
      candidateCoverage: candidate.regions[region].coverage,
      referenceCoverage: reference.regions[region].coverage
    });
  }
  return Object.freeze({
    coatColorScore,
    markingTopologyScore,
    faceIdentityScore,
    identityScore: (coatColorScore + markingTopologyScore) / 2,
    leftRightPlacementPreserved: isLeftRightPlacementPreserved(candidate.markingGrid, reference.markingGrid, options),
    regions: Object.freeze(regions)
  });
}

module.exports = {
  DEFAULT_APPEARANCE_OPTIONS,
  SUBJECT_APPEARANCE_CONTRACT_VERSION,
  compareColorHistograms,
  compareMarkingGrids,
  compareSubjectAppearance,
  estimateCanonicalGeometry,
  isLeftRightPlacementPreserved,
  measureSubjectFrame,
  normalizeAppearanceOptions
};
