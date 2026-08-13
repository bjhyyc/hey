import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import petpackModule from "../../src/main/services/petpack";

const { exportPetpack, importPetpack } = petpackModule;
const IDLE_ID = "20000000-0000-4000-8000-000000000001";
const WAVE_ID = "20000000-0000-4000-8000-000000000002";
const CLICK_ID = "20000000-0000-4000-8000-000000000003";

function createManifest(packageId = "demo-pet") {
  return {
    schemaVersion: "2.0.0",
    packageId,
    name: "Demo Pet",
    version: "1.0.0",
    preview: "preview.png",
    animations: {
      default: { id: IDLE_ID, name: "Idle", asset: "assets/idle.webm" },
      clips: [
        { id: WAVE_ID, name: "Wave", type: "oneshot", asset: "assets/wave.webm", durationMs: 900 }
      ]
    },
    triggerRules: [
      {
        id: "click-wave",
        name: "Click Wave",
        relation: "single",
        conditions: [{ type: "click" }],
        actions: [{ type: "playAnimation", animation: WAVE_ID, durationMs: 900 }]
      }
    ]
  };
}

async function writeZip(targetPath, files) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  fs.writeFileSync(targetPath, buffer);
}

describe("petpack", () => {
  let tempDir;
  let userDataDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-petpack-"));
    userDataDir = path.join(tempDir, "user-data");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("imports a valid petpack into userData packages", async () => {
    const petpackPath = path.join(tempDir, "demo.petpack");
    await writeZip(petpackPath, {
      "manifest.json": JSON.stringify(createManifest("demo-pet")),
      "preview.png": "preview",
      "assets/idle.webm": "idle",
      "assets/wave.webm": "wave"
    });

    const result = await importPetpack(petpackPath, userDataDir);

    expect(result).toEqual({ ok: true, packageId: "demo-pet", fileCount: 4 });
    expect(JSON.parse(fs.readFileSync(path.join(userDataDir, "packages", "demo-pet", "manifest.json"), "utf8"))).toMatchObject({
      packageId: "demo-pet"
    });
    expect(fs.readFileSync(path.join(userDataDir, "packages", "demo-pet", "assets", "idle.webm"), "utf8")).toBe("idle");
  });

  it("skips OS metadata entries when importing", async () => {
    const petpackPath = path.join(tempDir, "junk.petpack");
    await writeZip(petpackPath, {
      "manifest.json": JSON.stringify(createManifest("junk-pet")),
      "preview.png": "preview",
      "assets/idle.webm": "idle",
      "assets/wave.webm": "wave",
      ".DS_Store": "junk",
      "assets/.DS_Store": "junk",
      "assets/._idle.webm": "junk",
      "__MACOSX/manifest.json": "junk"
    });

    const result = await importPetpack(petpackPath, userDataDir);

    expect(result).toEqual({ ok: true, packageId: "junk-pet", fileCount: 4 });
    expect(fs.existsSync(path.join(userDataDir, "packages", "junk-pet", ".DS_Store"))).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, "packages", "junk-pet", "assets", "._idle.webm"))).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, "packages", "junk-pet", "__MACOSX"))).toBe(false);
  });

  it("rejects unsafe zip entries without partial writes", async () => {
    const petpackPath = path.join(tempDir, "unsafe.petpack");
    await writeZip(petpackPath, {
      "manifest.json": JSON.stringify(createManifest("unsafe-pet")),
      "preview.png": "preview",
      "assets/idle.webm": "idle",
      "assets/wave.webm": "wave",
      "../escape.txt": "bad"
    });

    const result = await importPetpack(petpackPath, userDataDir);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unsafe zip entry");
    expect(fs.existsSync(path.join(userDataDir, "packages", "unsafe-pet"))).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, "escape.txt"))).toBe(false);
  });

  it("rejects petpacks missing manifest.json", async () => {
    const petpackPath = path.join(tempDir, "missing-manifest.petpack");
    await writeZip(petpackPath, {
      "assets/idle.webm": "idle"
    });

    const result = await importPetpack(petpackPath, userDataDir);

    expect(result).toEqual({ ok: false, error: "manifest.json is required" });
    expect(fs.existsSync(path.join(userDataDir, "packages"))).toBe(false);
  });

  it("imports petpacks with many entries and large files (no size or count limits)", async () => {
    const petpackPath = path.join(tempDir, "big.petpack");
    const files = {
      "manifest.json": JSON.stringify(createManifest("big-pet")),
      "preview.png": "preview",
      "assets/idle.webm": "x".repeat(4096),
      "assets/wave.webm": "wave"
    };
    for (let index = 0; index < 20; index += 1) {
      files[`assets/extra-${index}.png`] = "extra";
    }
    await writeZip(petpackPath, files);

    const result = await importPetpack(petpackPath, userDataDir);

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, "packages", "big-pet"))).toBe(true);
  });

  it("rejects petpacks that are too large for available memory before reading the zip", async () => {
    const petpackPath = path.join(tempDir, "memory-pressure.petpack");
    await writeZip(petpackPath, {
      "manifest.json": JSON.stringify(createManifest("memory-pressure-pet")),
      "preview.png": "preview",
      "assets/idle.webm": "idle",
      "assets/wave.webm": "wave"
    });
    vi.spyOn(os, "freemem").mockReturnValue(1);

    const result = await importPetpack(petpackPath, userDataDir);

    expect(result).toEqual({ ok: false, error: "Petpack is too large for available memory" });
    expect(fs.existsSync(path.join(userDataDir, "packages", "memory-pressure-pet"))).toBe(false);
  });

  it("stops streamed extraction before consuming the available disk budget", async () => {
    const petpackPath = path.join(tempDir, "disk-pressure.petpack");
    await writeZip(petpackPath, {
      "manifest.json": JSON.stringify(createManifest("disk-pressure-pet")),
      "preview.png": "preview",
      "assets/idle.webm": "x".repeat(64),
      "assets/wave.webm": "wave"
    });
    vi.spyOn(os, "freemem").mockReturnValue(1024 * 1024 * 1024);
    vi.spyOn(fs, "statfsSync").mockReturnValue({ bavail: 20, bsize: 1 });

    const result = await importPetpack(petpackPath, userDataDir);

    expect(result).toEqual({ ok: false, error: "Petpack extracted content exceeds available disk budget" });
    expect(fs.existsSync(path.join(userDataDir, "packages", "disk-pressure-pet"))).toBe(false);
  });

  it("rejects explicit directory and symlink zip entries", async () => {
    const petpackPath = path.join(tempDir, "non-files.petpack");
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify(createManifest("non-files-pet")));
    zip.file("preview.png", "preview");
    zip.file("assets/idle.webm", "idle");
    zip.file("assets/wave.webm", "wave");
    zip.folder("assets/empty-dir");
    zip.file("assets/link.webm", "assets/idle.webm", { unixPermissions: 0o120777 });
    fs.writeFileSync(petpackPath, await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }));

    const result = await importPetpack(petpackPath, userDataDir);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unsafe zip entry|Zip entry cannot be a symbolic link/);
    expect(fs.existsSync(path.join(userDataDir, "packages", "non-files-pet"))).toBe(false);
  });

  it("exports a package zip containing manifest and assets", async () => {
    const packageDir = path.join(userDataDir, "packages", "export-pet");
    fs.mkdirSync(path.join(packageDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "manifest.json"), JSON.stringify(createManifest("export-pet")), "utf8");
    fs.writeFileSync(path.join(packageDir, "preview.png"), "preview", "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", "idle.webm"), "idle", "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", "wave.webm"), "wave", "utf8");
    const targetPath = path.join(tempDir, "export.petpack");

    const result = await exportPetpack("export-pet", userDataDir, targetPath);

    expect(result).toEqual({ ok: true, packageId: "export-pet", fileCount: 4, targetPath });
    const zip = await JSZip.loadAsync(fs.readFileSync(targetPath));
    expect(zip.file("manifest.json")).toBeTruthy();
    expect(zip.file("preview.png")).toBeTruthy();
    expect(zip.file("assets/idle.webm")).toBeTruthy();
    expect(JSON.parse(await zip.file("manifest.json").async("string")).packageId).toBe("export-pet");
  });

  it("exports a petpack manifest merged with saved panel config", async () => {
    const packageDir = path.join(userDataDir, "packages", "merged-pet");
    fs.mkdirSync(path.join(packageDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "manifest.json"), JSON.stringify(createManifest("merged-pet")), "utf8");
    fs.writeFileSync(path.join(packageDir, "preview.png"), "preview", "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", "idle.webm"), "idle", "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", "wave.webm"), "wave", "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", "click.webm"), "click", "utf8");
    const targetPath = path.join(tempDir, "merged.petpack");

    const result = await exportPetpack("merged-pet", userDataDir, targetPath, {
      animations: {
        default: { id: IDLE_ID, name: "Idle", asset: "assets/idle.webm" },
        clips: [
          { id: CLICK_ID, name: "Click", asset: "assets/click.webm", type: "oneshot", durationMs: 700 }
        ]
      },
      triggerRules: [
        { id: "configured-click", name: "Configured Click", relation: "single", conditions: [{ type: "click" }], actions: [{ type: "playAnimation", animation: CLICK_ID, durationMs: 700 }] }
      ]
    });

    expect(result.ok).toBe(true);
    const zip = await JSZip.loadAsync(fs.readFileSync(targetPath));
    const exportedManifest = JSON.parse(await zip.file("manifest.json").async("string"));
    expect(exportedManifest.animations.clips).toEqual([
      { id: CLICK_ID, name: "Click", asset: "assets/click.webm", type: "oneshot", durationMs: 700 }
    ]);
    expect(exportedManifest.triggerRules.find((rule) => rule.id === "configured-click")).toEqual({
      id: "configured-click",
      name: "Configured Click",
      relation: "single",
      conditions: [{ type: "click" }],
      actions: [{ type: "playAnimation", animation: CLICK_ID, durationMs: 700 }]
    });
  });

  it("restores an existing package when replacement rename fails", async () => {
    const packageDir = path.join(userDataDir, "packages", "demo-pet");
    fs.mkdirSync(path.join(packageDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "manifest.json"), JSON.stringify(createManifest("demo-pet")), "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", "idle.webm"), "old idle", "utf8");

    const petpackPath = path.join(tempDir, "demo.petpack");
    await writeZip(petpackPath, {
      "manifest.json": JSON.stringify(createManifest("demo-pet")),
      "preview.png": "preview",
      "assets/idle.webm": "new idle",
      "assets/wave.webm": "wave"
    });

    const originalRenameSync = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === packageDir && String(from).includes(".tmp-demo-pet-")) {
        throw new Error("simulated replacement failure");
      }
      return originalRenameSync(from, to);
    });

    const result = await importPetpack(petpackPath, userDataDir);

    expect(result).toEqual({ ok: false, error: "simulated replacement failure" });
    expect(fs.readFileSync(path.join(packageDir, "assets", "idle.webm"), "utf8")).toBe("old idle");
    expect(fs.readdirSync(path.dirname(packageDir)).filter((name) => name.includes(".tmp-demo-pet-"))).toEqual([]);
  });

  it("keeps an existing export when final rename fails", async () => {
    const packageDir = path.join(userDataDir, "packages", "export-pet");
    fs.mkdirSync(path.join(packageDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "manifest.json"), JSON.stringify(createManifest("export-pet")), "utf8");
    fs.writeFileSync(path.join(packageDir, "preview.png"), "preview", "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", "idle.webm"), "idle", "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", "wave.webm"), "wave", "utf8");
    const targetPath = path.join(tempDir, "existing.petpack");
    fs.writeFileSync(targetPath, "previous export", "utf8");

    const originalRenameSync = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === targetPath && String(from).includes(".tmp-existing.petpack-")) {
        throw new Error("simulated export replacement failure");
      }
      return originalRenameSync(from, to);
    });

    const result = await exportPetpack("export-pet", userDataDir, targetPath);

    expect(result).toEqual({ ok: false, error: "simulated export replacement failure" });
    expect(fs.readFileSync(targetPath, "utf8")).toBe("previous export");
    expect(fs.readdirSync(tempDir).filter((name) => name.includes(".tmp-existing.petpack-"))).toEqual([]);
  });

  it("rejects export when manifest references missing package files", async () => {
    const packageDir = path.join(userDataDir, "packages", "broken-pet");
    fs.mkdirSync(path.join(packageDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "manifest.json"), JSON.stringify(createManifest("broken-pet")), "utf8");
    fs.writeFileSync(path.join(packageDir, "preview.png"), "preview", "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", "idle.webm"), "idle", "utf8");
    const targetPath = path.join(tempDir, "broken.petpack");

    const result = await exportPetpack("broken-pet", userDataDir, targetPath);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("asset not found: assets/wave.webm");
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("skips OS metadata files (.DS_Store, __MACOSX, ._*) when exporting", async () => {
    const packageDir = path.join(userDataDir, "packages", "junk-export-pet");
    fs.mkdirSync(path.join(packageDir, "assets"), { recursive: true });
    fs.mkdirSync(path.join(packageDir, "__MACOSX"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "manifest.json"), JSON.stringify(createManifest("junk-export-pet")), "utf8");
    fs.writeFileSync(path.join(packageDir, "preview.png"), "preview", "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", "idle.webm"), "idle", "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", "wave.webm"), "wave", "utf8");
    fs.writeFileSync(path.join(packageDir, ".DS_Store"), "junk", "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", ".DS_Store"), "junk", "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", "._idle.webm"), "junk", "utf8");
    fs.writeFileSync(path.join(packageDir, "__MACOSX", "manifest.json"), "junk", "utf8");
    const targetPath = path.join(tempDir, "junk.petpack");

    const result = await exportPetpack("junk-export-pet", userDataDir, targetPath);

    expect(result.ok).toBe(true);
    const zip = await JSZip.loadAsync(fs.readFileSync(targetPath));
    const entryNames = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
    expect(entryNames).toEqual(expect.arrayContaining([
      "manifest.json", "preview.png", "assets/idle.webm", "assets/wave.webm"
    ]));
    expect(entryNames).not.toContain(".DS_Store");
    expect(entryNames).not.toContain("assets/.DS_Store");
    expect(entryNames).not.toContain("assets/._idle.webm");
    expect(entryNames.some((name) => name.startsWith("__MACOSX/"))).toBe(false);
  });

  it("rejects export when package contains unsupported extra files", async () => {
    const packageDir = path.join(userDataDir, "packages", "unsupported-export-pet");
    fs.mkdirSync(path.join(packageDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "manifest.json"), JSON.stringify(createManifest("unsupported-export-pet")), "utf8");
    fs.writeFileSync(path.join(packageDir, "preview.png"), "preview", "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", "idle.webm"), "idle", "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", "wave.webm"), "wave", "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", "debug.exe"), "bad", "utf8");
    const targetPath = path.join(tempDir, "unsupported.petpack");

    const result = await exportPetpack("unsupported-export-pet", userDataDir, targetPath);

    expect(result).toEqual({
      ok: false,
      error: "Package file extension is not supported: assets/debug.exe"
    });
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("rejects export when manifest packageId is unsafe", async () => {
    const packageDir = path.join(userDataDir, "packages", "safe-pet");
    fs.mkdirSync(path.join(packageDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "manifest.json"), JSON.stringify(createManifest("../escape")), "utf8");
    fs.writeFileSync(path.join(packageDir, "preview.png"), "preview", "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", "idle.webm"), "idle", "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", "wave.webm"), "wave", "utf8");
    const targetPath = path.join(tempDir, "unsafe-id.petpack");

    const result = await exportPetpack("safe-pet", userDataDir, targetPath);

    expect(result).toEqual({ ok: false, error: "Manifest package ID is unsafe" });
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("rejects export when manifest packageId differs from selected packageId", async () => {
    const packageDir = path.join(userDataDir, "packages", "safe-pet");
    fs.mkdirSync(path.join(packageDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "manifest.json"), JSON.stringify(createManifest("other-pet")), "utf8");
    fs.writeFileSync(path.join(packageDir, "preview.png"), "preview", "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", "idle.webm"), "idle", "utf8");
    fs.writeFileSync(path.join(packageDir, "assets", "wave.webm"), "wave", "utf8");
    const targetPath = path.join(tempDir, "wrong-id.petpack");

    const result = await exportPetpack("safe-pet", userDataDir, targetPath);

    expect(result).toEqual({ ok: false, error: "Manifest package ID does not match selected package" });
    expect(fs.existsSync(targetPath)).toBe(false);
  });
});
