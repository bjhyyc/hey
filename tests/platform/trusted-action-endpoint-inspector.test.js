import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FRAME_BYTES = 854 * 480 * 4;
const repoRoot = path.resolve(".");
const ffmpegPath = path.resolve("node_modules/ffmpeg-static/ffmpeg.exe");
const fixtureRoot = path.resolve(".tmp/tests/trusted-endpoint-fixture");

function fakeSpawnFactory({ mismatch = false } = {}) {
  let invocation = 0;
  return (_executable, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      invocation += 1;
      const isEndpointDecode = args.includes("-frames:v") && args.includes("2");
      const frame = Buffer.alloc(FRAME_BYTES, 255);
      const second = mismatch && isEndpointDecode ? Buffer.alloc(FRAME_BYTES, 0) : frame;
      const output = isEndpointDecode ? Buffer.concat([frame, second]) : frame;
      child.stdout.emit("data", output);
      child.emit("close", 0);
    });
    return child;
  };
}

async function loadInspector(options) {
  const module = await import("../../platform/src/qa/trusted-action-endpoint-inspector.js");
  return module.createTrustedActionEndpointInspector({ ffmpegPath, ...options });
}

describe("trusted action endpoint inspector", () => {
  it("covers every frozen Studio action endpoint", async () => {
    const inspectorModule = await import("../../platform/src/qa/trusted-action-endpoint-inspector.js");
    const actionCatalog = await import("../../platform/src/domain/action-catalog.js");
    expect(Object.keys(inspectorModule.ACTION_ENDPOINTS).sort())
      .toEqual([...actionCatalog.REQUIRED_ACTION_IDS].sort());
  });

  it("decodes and binds both endpoints to the supplied master bytes", async () => {
    fs.mkdirSync(fixtureRoot, { recursive: true });
    const front = path.join(fixtureRoot, "front.png");
    const sleep = path.join(fixtureRoot, "sleep.png");
    const output = path.join(fixtureRoot, "sleep-transition.webm");
    fs.writeFileSync(front, "front-master");
    fs.writeFileSync(sleep, "sleep-master");
    fs.writeFileSync(output, "normalized-output");
    const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const inspect = await loadInspector({ spawnImpl: fakeSpawnFactory() });
    const result = await inspect({
      actionId: "sleep-transition",
      outputPath: output,
      firstMasterPath: front,
      lastMasterPath: sleep,
      expectedFirstMasterHash: sha(front),
      expectedLastMasterHash: sha(sleep),
      frameCount: 144
    });
    expect(result.firstMasterKind).toBe("front");
    expect(result.lastMasterKind).toBe("sleep");
    expect(result.terminalFrameMatches).toBe(true);
    expect(result.trustedDecoder.kind).toBe("ffmpeg-libvpx-vp9-rgba/v1");
    expect(result.outputFrameCount).toBe(144);
  });

  it("fails closed when the decoded terminal frame differs", async () => {
    fs.mkdirSync(fixtureRoot, { recursive: true });
    const front = path.join(fixtureRoot, "front-2.png");
    const sleep = path.join(fixtureRoot, "sleep-2.png");
    const output = path.join(fixtureRoot, "sleep-transition-2.webm");
    fs.writeFileSync(front, "front-master");
    fs.writeFileSync(sleep, "sleep-master");
    fs.writeFileSync(output, "normalized-output");
    const inspect = await loadInspector({ spawnImpl: fakeSpawnFactory({ mismatch: true }) });
    await expect(inspect({
      actionId: "sleep-transition",
      outputPath: output,
      firstMasterPath: front,
      lastMasterPath: sleep,
      frameCount: 144
    })).rejects.toMatchObject({ code: "action_endpoint_continuity_failed" });
  });
});
