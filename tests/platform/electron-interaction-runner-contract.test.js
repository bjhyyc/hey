import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import runnerModule from "../../platform/src/petpack/run-electron-interaction-verification.js";

const {
  PROTOCOL_VERSION,
  REQUIRED_ACTION_IDS,
  checksumPinnedClientTree,
  createVerificationCursor,
  getBehaviorContract,
  installVerificationCursorTracker,
  normalizeRunnerRequest,
  parseRunnerArguments
} = runnerModule;

const temporaryRoots = [];

function temporaryRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `petpack-electron-runner-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function createFakeClient() {
  const root = temporaryRoot("client");
  fs.mkdirSync(path.join(root, "src", "main"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"pinned-client"}\n');
  fs.writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(root, "src", "main", "main.js"), 'module.exports = "pinned";\n');
  return root;
}

function validManifest() {
  const actionClipIds = {
    idle: "idle-id",
    sneeze: "sneeze-id",
    roll: "roll-id",
    sleepTransition: "sleep-transition-id",
    sleepLoop: "sleep-loop-id",
    stretch: "stretch-id",
    hoverAttention: "hover-attention-id"
  };
  return {
    packageId: "petpack-test",
    animations: {
      default: { id: "idle-id", asset: "assets/idle.webm" },
      clips: [
        { id: "sneeze-id", asset: "assets/sneeze.webm", durationMs: 4000 },
        { id: "roll-id", asset: "assets/roll.webm", durationMs: 6000 },
        { id: "sleep-transition-id", asset: "assets/sleep-transition.webm", durationMs: 6000 },
        { id: "sleep-loop-id", asset: "assets/sleep-loop.webm", durationMs: 6000 },
        { id: "stretch-id", asset: "assets/stretch.webm", durationMs: 7000 },
        { id: "hover-attention-id", asset: "assets/hover-attention.webm", durationMs: 7000 }
      ]
    },
    studioBehavior: {
      profile: "petpack-studio/v1",
      actionClipIds,
      timing: { idleTimeoutMs: 22000, hoverDelayMs: 2000, hoverCooldownMs: 20000 }
    },
    triggerRules: []
  };
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const selected = temporaryRoots.pop();
    const relative = path.relative(os.tmpdir(), selected);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) &&
        path.basename(selected).startsWith("petpack-electron-runner-")) {
      fs.rmSync(selected, { recursive: true, force: true });
    }
  }
});

describe("Electron interaction runner contract", () => {
  it("isolates the global cursor and maps client input to screen coordinates", () => {
    const screen = {
      getCursorScreenPoint() {
        return { x: 7, y: 11 };
      }
    };
    // Chromium reports a synthetic event's screen position from the real
    // pointer, so the cursor must actually move it; a purely bookkeeping cursor
    // leaves every hover probe sampling wherever the pointer already sat.
    const warps = [];
    const cursor = createVerificationCursor(screen, (x, y) => warps.push({ x, y }));
    expect(cursor.read()).toEqual({ x: 7, y: 11 });
    expect(cursor.set({ getBounds: () => ({ x: -120, y: 45 }) }, { x: 30, y: 55 })).toEqual({
      x: -90,
      y: 100
    });
    expect(cursor.read()).toEqual({ x: -90, y: 100 });
    expect(warps).toEqual([{ x: -90, y: 100 }]);
    expect(screen.getCursorScreenPoint()).toEqual({ x: 7, y: 11 });
  });

  it("injects the isolated cursor through the tracker dependency boundary", () => {
    const root = createFakeClient();
    const trackerPath = path.join(root, "src", "main", "global-mouse-tracker.js");
    fs.writeFileSync(
      trackerPath,
      "module.exports={createGlobalMouseTracker(options){return options;}};\n"
    );
    const cursor = Object.freeze({ read: () => ({ x: 31, y: 47 }) });
    installVerificationCursorTracker(root, cursor);
    const tracker = require(trackerPath).createGlobalMouseTracker({
      getPetWindow: () => null,
      screenGetter: () => ({ getCursorScreenPoint: () => ({ x: 0, y: 0 }) })
    });
    expect(tracker.screenGetter().getCursorScreenPoint()).toEqual({ x: 31, y: 47 });
  });

  it("requires exactly the pinned client root and checksum arguments", () => {
    const root = createFakeClient();
    const digest = checksumPinnedClientTree(root).sha256;
    expect(parseRunnerArguments([
      `--client-root=${root}`,
      `--client-tree-sha256=${digest}`
    ])).toEqual({ clientRoot: path.resolve(root), expectedClientTreeSha256: digest });
    expect(() => parseRunnerArguments([`--client-root=${root}`])).toThrow(/exactly two/);
    expect(() => parseRunnerArguments([
      `--client-root=${root}`,
      `--unknown=${digest}`
    ])).toThrow(/unsupported or duplicated/);
  });

  it("hashes the pinned package files and complete client source tree", () => {
    const root = createFakeClient();
    const first = checksumPinnedClientTree(root);
    const second = checksumPinnedClientTree(root);
    expect(first).toEqual(second);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    fs.writeFileSync(path.join(root, "src", "main", "main.js"), 'module.exports = "changed";\n');
    expect(checksumPinnedClientTree(root).sha256).not.toBe(first.sha256);
  });

  it("binds an exact request to a regular PetPack inside its workspace", () => {
    const workspace = temporaryRoot("request");
    const packagePath = path.join(workspace, "input.petpack");
    const bytes = Buffer.from("immutable-petpack");
    fs.writeFileSync(packagePath, bytes);
    const request = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      packagePath,
      packageId: "petpack-test",
      packageSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      packageByteSize: bytes.length,
      workspacePath: workspace,
      actionIds: [...REQUIRED_ACTION_IDS]
    };
    expect(normalizeRunnerRequest(request)).toMatchObject({
      packageId: "petpack-test",
      packageByteSize: bytes.length,
      actionIds: [...REQUIRED_ACTION_IDS]
    });
    expect(() => normalizeRunnerRequest({ ...request, unexpected: true })).toThrow(/unsupported fields/);
    expect(() => normalizeRunnerRequest({ ...request, actionIds: REQUIRED_ACTION_IDS.slice(1) })).toThrow(/incomplete/);
  });

  it("rejects a PetPack path outside the declared workspace", () => {
    const workspace = temporaryRoot("inside");
    const outside = temporaryRoot("outside");
    const packagePath = path.join(outside, "input.petpack");
    const bytes = Buffer.from("outside-petpack");
    fs.writeFileSync(packagePath, bytes);
    expect(() => normalizeRunnerRequest({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      packagePath,
      packageId: "petpack-test",
      packageSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      packageByteSize: bytes.length,
      workspacePath: workspace,
      actionIds: [...REQUIRED_ACTION_IDS]
    })).toThrow(/escaped its workspace/);
  });

  it("derives all seven animations and immutable Studio timing", () => {
    const contract = getBehaviorContract(validManifest(), REQUIRED_ACTION_IDS);
    expect(contract.actions.idle.id).toBe("idle-id");
    expect(contract.actions["sleep-transition"].id).toBe("sleep-transition-id");
    expect(contract.actions["hover-attention"].durationMs).toBe(7000);
    expect(contract.timing).toEqual({ idleTimeoutMs: 22000, hoverDelayMs: 2000, hoverCooldownMs: 20000 });
  });

  it("rejects movement, generic rules, and timing drift", () => {
    const moved = validManifest();
    moved.animations.clips[0].movement = { direction: "right", distance: 10 };
    expect(() => getBehaviorContract(moved, REQUIRED_ACTION_IDS)).toThrow(/action contract is invalid/);

    const generic = validManifest();
    generic.triggerRules.push({ id: "extra" });
    expect(() => getBehaviorContract(generic, REQUIRED_ACTION_IDS)).toThrow(/generic trigger rules/);

    const timing = validManifest();
    timing.studioBehavior.timing.idleTimeoutMs = 21000;
    expect(() => getBehaviorContract(timing, REQUIRED_ACTION_IDS)).toThrow(/timing contract is invalid/);
  });
});
