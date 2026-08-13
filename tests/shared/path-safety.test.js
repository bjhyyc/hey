import { describe, expect, it } from "vitest";
import pathSafety from "../../src/shared/path-safety";

const { isSafeRelativePath } = pathSafety;

describe("isSafeRelativePath", () => {
  it("accepts safe relative paths", () => {
    expect(isSafeRelativePath("assets/idle.webm")).toBe(true);
    expect(isSafeRelativePath("manifest.json")).toBe(true);
  });

  it("rejects path traversal", () => {
    expect(isSafeRelativePath("../manifest.json")).toBe(false);
    expect(isSafeRelativePath("assets/../manifest.json")).toBe(false);
  });

  it("rejects absolute paths", () => {
    expect(isSafeRelativePath("/tmp/manifest.json")).toBe(false);
    expect(isSafeRelativePath("C:/tmp/manifest.json")).toBe(false);
  });

  it("rejects backslashes", () => {
    expect(isSafeRelativePath("assets\\idle.webm")).toBe(false);
  });

  it("rejects empty segments and normalized mismatches", () => {
    expect(isSafeRelativePath("")).toBe(false);
    expect(isSafeRelativePath("assets//idle.webm")).toBe(false);
    expect(isSafeRelativePath("assets/./idle.webm")).toBe(false);
  });
});
