import { describe, expect, it } from "vitest";
import { readImageHeaderDimensions } from "../../platform/src/media/image-header-dimensions.js";

// The header parser is what stands between a phone photograph and a paid run
// that dies in master generation, so each container it claims to read is
// covered with bytes laid out by hand.

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpegHeader(width, height, { marker = 0xc0, withPreamble = true } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (withPreamble) {
    // An APP0 segment, so the parser has to walk past a length-carrying marker.
    const app0 = Buffer.alloc(4 + 14);
    app0.writeUInt16BE(0xffe0, 0);
    app0.writeUInt16BE(16, 2);
    parts.push(app0);
  }
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xff00 | marker, 0);
  sof.writeUInt16BE(9, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof);
  return Buffer.concat(parts);
}

function webpVp8x(width, height) {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "latin1");
  buffer.write("WEBP", 8, "latin1");
  buffer.write("VP8X", 12, "latin1");
  const w = width - 1;
  const h = height - 1;
  buffer[24] = w & 0xff;
  buffer[25] = (w >> 8) & 0xff;
  buffer[26] = (w >> 16) & 0xff;
  buffer[27] = h & 0xff;
  buffer[28] = (h >> 8) & 0xff;
  buffer[29] = (h >> 16) & 0xff;
  return buffer;
}

describe("image header dimensions", () => {
  it("reads a PNG", () => {
    expect(readImageHeaderDimensions(pngHeader(3010, 4515))).toEqual({ width: 3010, height: 4515 });
  });

  it("reads a JPEG past its APP0 segment", () => {
    expect(readImageHeaderDimensions(jpegHeader(4032, 3024))).toEqual({ width: 4032, height: 3024 });
  });

  it("reads a progressive JPEG", () => {
    expect(readImageHeaderDimensions(jpegHeader(1920, 1080, { marker: 0xc2 }))).toEqual({ width: 1920, height: 1080 });
  });

  it("does not mistake a Huffman table marker for a frame header", () => {
    // 0xc4 sits inside the SOF numeric range but carries Huffman tables.
    expect(readImageHeaderDimensions(jpegHeader(800, 600, { marker: 0xc4 }))).toBeNull();
  });

  it("reads an extended WebP", () => {
    expect(readImageHeaderDimensions(webpVp8x(5000, 2500))).toEqual({ width: 5000, height: 2500 });
  });

  it("returns null for bytes it cannot read", () => {
    expect(readImageHeaderDimensions(Buffer.from("not an image at all!!"))).toBeNull();
    expect(readImageHeaderDimensions(Buffer.alloc(4))).toBeNull();
    expect(readImageHeaderDimensions(null)).toBeNull();
  });
});
