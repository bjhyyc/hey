"use strict";

// Reads pixel dimensions straight out of an image header. The API runtime has
// no ffmpeg and does not need one for this: JPEG, PNG and WebP all carry width
// and height within the first few kilobytes, so a ranged read is enough to
// refuse a photograph the master processor would later choke on.

const MAX_HEADER_BYTES = 64 * 1024;

function readPng(buffer) {
  // 8-byte signature, then an IHDR chunk whose data begins at offset 16.
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buffer.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readJpeg(buffer) {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    // Any start-of-frame marker holds the dimensions; the arithmetic-coded and
    // progressive variants sit in the same ranges, minus the four markers that
    // mean something else.
    const isStartOfFrame = (marker >= 0xc0 && marker <= 0xcf) &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (offset + 9 >= buffer.length) return null;
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function readWebp(buffer) {
  if (buffer.length < 30) return null;
  if (buffer.toString("latin1", 0, 4) !== "RIFF" || buffer.toString("latin1", 8, 12) !== "WEBP") return null;
  const format = buffer.toString("latin1", 12, 16);
  if (format === "VP8 ") {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (format === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (format === "VP8X") {
    const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
    const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    return { width, height };
  }
  return null;
}

/**
 * Returns { width, height } for a JPEG, PNG or WebP header, or null when the
 * bytes are not one of those or the header is truncated.
 */
function readImageHeaderDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  const dimensions = readPng(buffer) || readJpeg(buffer) || readWebp(buffer);
  if (!dimensions) return null;
  const { width, height } = dimensions;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return null;
  return { width, height };
}

module.exports = { MAX_HEADER_BYTES, readImageHeaderDimensions };
