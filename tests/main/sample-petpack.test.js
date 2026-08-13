import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { SAMPLE_PETPACK_URL, installSamplePetpack } = require("../../src/main/services/sample-petpack");

describe("sample petpack installer", () => {
  const createdDirs = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("downloads to a temporary file, imports it, and removes the download", async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-sample-test-"));
    createdDirs.push(userDataDir);
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("sample-petpack"), { status: 200 }));
    let importedPath = "";
    const importPetpackImpl = vi.fn(async (filePath, receivedUserDataDir) => {
      importedPath = filePath;
      expect(receivedUserDataDir).toBe(userDataDir);
      expect(fs.readFileSync(filePath, "utf8")).toBe("sample-petpack");
      return { ok: true, packageId: "taotao" };
    });

    const result = await installSamplePetpack({ fetchImpl, userDataDir, importPetpackImpl });

    expect(result).toEqual({ ok: true, packageId: "taotao" });
    expect(fetchImpl).toHaveBeenCalledWith(SAMPLE_PETPACK_URL, expect.objectContaining({
      redirect: "follow",
      signal: expect.any(AbortSignal)
    }));
    expect(importPetpackImpl).toHaveBeenCalledOnce();
    expect(fs.existsSync(importedPath)).toBe(false);
  });

  it("rejects unsuccessful downloads before attempting import", async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-sample-test-"));
    createdDirs.push(userDataDir);
    const importPetpackImpl = vi.fn();

    await expect(installSamplePetpack({
      fetchImpl: vi.fn(async () => new Response("unavailable", { status: 503 })),
      userDataDir,
      importPetpackImpl
    })).rejects.toThrow("Sample petpack download failed (503)");

    expect(importPetpackImpl).not.toHaveBeenCalled();
  });
});
