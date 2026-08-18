import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import actionCatalogModule from "../../platform/src/domain/action-catalog.js";
import deliveryValidatorModule from "../../platform/src/petpack/delivery-validator.js";
import electronInteractionModule from "../../platform/src/petpack/electron-interaction-verifier.js";

const {
  ELECTRON_INTERACTION_PROTOCOL_VERSION,
  PetpackDeliveryValidator,
  REQUIRED_INTERACTION_CHECKS,
  checksumFile,
  checksumPinnedUpstreamTree,
  createElectronInteractionVerifier,
  createUpstreamImportVerifier
} = deliveryValidatorModule;
const { createPinnedElectronInteractionVerifier } = electronInteractionModule;
const { REQUIRED_ACTION_IDS } = actionCatalogModule;

const temporaryDirectories = [];

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "electron-interaction-verifier-test-"));
  temporaryDirectories.push(directory);
  const electronExecutablePath = path.join(directory, process.platform === "win32" ? "electron.exe" : "electron");
  const runnerPath = path.join(directory, "interaction-runner.js");
  const packagePath = path.join(directory, "package.petpack");
  fs.writeFileSync(electronExecutablePath, "pinned-electron-runtime");
  fs.writeFileSync(runnerPath, "// reviewed Electron interaction runner\n");
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
    name: "petpack-electron-interaction-runner",
    version: "1.0.0",
    private: true,
    main: path.basename(runnerPath)
  }));
  fs.writeFileSync(packagePath, "immutable-petpack");
  return {
    directory,
    electronExecutablePath,
    expectedElectronExecutableSha256: sha256File(electronExecutablePath),
    runnerPath,
    expectedRunnerSha256: sha256File(runnerPath),
    packagePath,
    packageSha256: sha256File(packagePath)
  };
}

function fakeChildProcess(onRequest) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  const input = [];
  child.stdin.on("data", (chunk) => input.push(Buffer.from(chunk)));
  child.stdin.on("finish", () => {
    const request = JSON.parse(Buffer.concat(input).toString("utf8"));
    queueMicrotask(() => onRequest({ child, request }));
  });
  return child;
}

function successfulResponse(request, overrides = {}) {
  return {
    protocolVersion: ELECTRON_INTERACTION_PROTOCOL_VERSION,
    requestId: request.requestId,
    ok: true,
    packageId: request.packageId,
    packageSha256: request.packageSha256,
    packageByteSize: request.packageByteSize,
    checks: Object.fromEntries(REQUIRED_INTERACTION_CHECKS.map((check) => [check, true])),
    ...overrides
  };
}

function respondingSpawn(responder = (request) => successfulResponse(request)) {
  return vi.fn(() => fakeChildProcess(({ child, request }) => {
    const response = responder(request);
    child.stdout.end(`${JSON.stringify(response)}\n`);
    child.emit("close", 0, null);
  }));
}

function createVerifier(fixture, overrides = {}) {
  return createPinnedElectronInteractionVerifier({
    electronExecutablePath: fixture.electronExecutablePath,
    expectedElectronExecutableSha256: fixture.expectedElectronExecutableSha256,
    runnerPath: fixture.runnerPath,
    expectedRunnerSha256: fixture.expectedRunnerSha256,
    identity: "desktop-pet-electron-e2e@reviewed",
    spawnImpl: respondingSpawn(),
    timeoutMs: 1000,
    requiredActionIds: REQUIRED_ACTION_IDS,
    requiredInteractionChecks: REQUIRED_INTERACTION_CHECKS,
    ...overrides
  });
}

function createAttestedVerifier(fixture, overrides = {}) {
  return createElectronInteractionVerifier({
    electronExecutablePath: fixture.electronExecutablePath,
    expectedElectronExecutableSha256: fixture.expectedElectronExecutableSha256,
    runnerPath: fixture.runnerPath,
    expectedRunnerSha256: fixture.expectedRunnerSha256,
    identity: "desktop-pet-electron-e2e@reviewed",
    timeoutMs: 1000,
    ...overrides
  });
}

function createPinnedUpstreamVerifier(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "electron-interaction-upstream-test-"));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, "src", "main", "services"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(root, "src", "main", "services", "petpack.js"), "module.exports = {};\n");
  return createUpstreamImportVerifier({
    upstreamRoot: root,
    expectedSourceTreeSha256: checksumPinnedUpstreamTree(root),
    timeoutMs: 1000,
    ...overrides
  });
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("attested Electron interaction verifier", () => {
  it("round-trips the protocol through a real child process", async () => {
    const fixture = createFixture();
    fs.writeFileSync(fixture.runnerPath, [
      `const requiredChecks = ${JSON.stringify(REQUIRED_INTERACTION_CHECKS)};`,
      "const chunks = [];",
      "process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));",
      "process.stdin.on('end', () => {",
      "  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
      "  process.stdout.write(JSON.stringify({",
      "    protocolVersion: request.protocolVersion,",
      "    requestId: request.requestId,",
      "    ok: true,",
      "    packageId: request.packageId,",
      "    packageSha256: request.packageSha256,",
      "    packageByteSize: request.packageByteSize,",
      "    checks: Object.fromEntries(requiredChecks.map((check) => [check, true]))",
      "  }));",
      "});"
    ].join("\n"));
    const executable = await checksumFile(process.execPath);
    const childEnvironment = {};
    for (const name of ["SystemRoot", "WINDIR"]) {
      if (typeof process.env[name] === "string") childEnvironment[name] = process.env[name];
    }
    const verifier = createElectronInteractionVerifier({
      electronExecutablePath: process.execPath,
      expectedElectronExecutableSha256: executable.sha256,
      runnerPath: fixture.runnerPath,
      expectedRunnerSha256: sha256File(fixture.runnerPath),
      identity: "node-child-protocol-smoke",
      childEnvironment,
      timeoutMs: 5000
    });

    await expect(verifier.verify({
      packagePath: fixture.packagePath,
      expectedPackageId: "package-real-child",
      packageSha256: fixture.packageSha256,
      actionIds: ["idle", "sneeze", "roll", "sleep-transition", "sleep-loop", "stretch", "hover-attention"]
    })).resolves.toMatchObject({
      ok: true,
      packageId: "package-real-child",
      packageSha256: fixture.packageSha256
    });
  });

  it("uses a bounded stdin JSON protocol and returns only package-bound required checks", async () => {
    const fixture = createFixture();
    let receivedRequest;
    const spawnImpl = respondingSpawn((request) => {
      receivedRequest = request;
      return successfulResponse(request, { ignoredChildField: "not trusted" });
    });
    const verifier = createVerifier(fixture, {
      spawnImpl,
      runnerArguments: ["--headless"],
      childEnvironment: { DISPLAY: ":99", PETPACK_E2E_MODE: "true" }
    });

    const result = await verifier.verify({
      packagePath: fixture.packagePath,
      expectedPackageId: "package-123",
      packageSha256: fixture.packageSha256,
      actionIds: ["hover-attention", "stretch", "sleep-loop", "sleep-transition", "roll", "sneeze", "idle"]
    });

    expect(verifier).toMatchObject({
      mode: "electron-runtime",
      identity: "desktop-pet-electron-e2e@reviewed",
      protocolVersion: ELECTRON_INTERACTION_PROTOCOL_VERSION,
      electronExecutableSha256: fixture.expectedElectronExecutableSha256,
      runnerSha256: fixture.expectedRunnerSha256
    });
    expect(Object.isFrozen(verifier)).toBe(true);
    expect(receivedRequest).toMatchObject({
      protocolVersion: ELECTRON_INTERACTION_PROTOCOL_VERSION,
      packagePath: fs.realpathSync(fixture.packagePath),
      packageId: "package-123",
      packageSha256: fixture.packageSha256,
      packageByteSize: Buffer.byteLength("immutable-petpack"),
      workspacePath: path.dirname(fs.realpathSync(fixture.packagePath)),
      actionIds: ["idle", "sneeze", "roll", "sleep-transition", "sleep-loop", "stretch", "hover-attention"]
    });
    expect(receivedRequest.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result).toEqual({
      ok: true,
      packageId: "package-123",
      packageSha256: fixture.packageSha256,
      checks: Object.fromEntries(REQUIRED_INTERACTION_CHECKS.map((check) => [check, true]))
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      fs.realpathSync(fixture.electronExecutablePath),
      [path.dirname(fs.realpathSync(fixture.runnerPath)), "--headless"],
      expect.objectContaining({
        cwd: path.dirname(fs.realpathSync(fixture.runnerPath)),
        env: { NODE_ENV: "production", DISPLAY: ":99", PETPACK_E2E_MODE: "true" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      })
    );
  });

  it("rejects a response that is not bound to the request nonce and PetPack hash", async () => {
    const fixture = createFixture();
    const wrongNonce = createVerifier(fixture, {
      spawnImpl: respondingSpawn((request) => successfulResponse(request, { requestId: crypto.randomUUID() }))
    });
    await expect(wrongNonce.verify({
      packagePath: fixture.packagePath,
      expectedPackageId: "package-123",
      packageSha256: fixture.packageSha256,
      actionIds: ["idle", "sneeze", "roll", "sleep-transition", "sleep-loop", "stretch", "hover-attention"]
    })).rejects.toThrow(/protocol binding/i);

    const wrongHash = createVerifier(fixture, {
      spawnImpl: respondingSpawn((request) => successfulResponse(request, { packageSha256: "f".repeat(64) }))
    });
    await expect(wrongHash.verify({
      packagePath: fixture.packagePath,
      expectedPackageId: "package-123",
      packageSha256: fixture.packageSha256,
      actionIds: ["idle", "sneeze", "roll", "sleep-transition", "sleep-loop", "stretch", "hover-attention"]
    })).rejects.toThrow(/different PetPack/i);
  });

  it("refuses changed runner bytes and mismatched PetPack bytes before spawning", async () => {
    const fixture = createFixture();
    const spawnImpl = respondingSpawn();
    const verifier = createVerifier(fixture, { spawnImpl });
    fs.appendFileSync(fixture.runnerPath, "// changed after attestation\n");
    await expect(verifier.verify({
      packagePath: fixture.packagePath,
      expectedPackageId: "package-123",
      packageSha256: fixture.packageSha256,
      actionIds: ["idle", "sneeze", "roll", "sleep-transition", "sleep-loop", "stretch", "hover-attention"]
    })).rejects.toThrow(/runner changed/i);
    expect(spawnImpl).not.toHaveBeenCalled();

    const secondFixture = createFixture();
    const secondSpawn = respondingSpawn();
    const secondVerifier = createVerifier(secondFixture, { spawnImpl: secondSpawn });
    await expect(secondVerifier.verify({
      packagePath: secondFixture.packagePath,
      expectedPackageId: "package-123",
      packageSha256: "0".repeat(64),
      actionIds: ["idle", "sneeze", "roll", "sleep-transition", "sleep-loop", "stretch", "hover-attention"]
    })).rejects.toThrow(/expected checksum/i);
    expect(secondSpawn).not.toHaveBeenCalled();
  });

  it("kills a silent child when the bounded timeout expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fixture = createFixture();
    let started;
    const childStarted = new Promise((resolve) => { started = resolve; });
    const child = fakeChildProcess(() => {});
    const spawnImpl = vi.fn(() => {
      started();
      return child;
    });
    const verifier = createVerifier(fixture, { spawnImpl, timeoutMs: 1000 });
    const verification = verifier.verify({
      packagePath: fixture.packagePath,
      expectedPackageId: "package-123",
      packageSha256: fixture.packageSha256,
      actionIds: ["idle", "sneeze", "roll", "sleep-transition", "sleep-loop", "stretch", "hover-attention"]
    });
    const timedOut = expect(verification).rejects.toThrow(/exceeded its timeout/i);
    await childStarted;
    await vi.advanceTimersByTimeAsync(1001);
    await timedOut;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("terminates children on a broken request channel or oversized stdout", async () => {
    const fixture = createFixture();
    const brokenChild = new EventEmitter();
    brokenChild.stdin = {
      once: vi.fn(),
      end: vi.fn(() => { throw new Error("stdin closed"); })
    };
    brokenChild.stdout = new PassThrough();
    brokenChild.stderr = new PassThrough();
    brokenChild.kill = vi.fn();
    const brokenVerifier = createVerifier(fixture, { spawnImpl: vi.fn(() => brokenChild) });
    await expect(brokenVerifier.verify({
      packagePath: fixture.packagePath,
      expectedPackageId: "package-123",
      packageSha256: fixture.packageSha256,
      actionIds: ["idle", "sneeze", "roll", "sleep-transition", "sleep-loop", "stretch", "hover-attention"]
    })).rejects.toThrow(/request failed/i);
    expect(brokenChild.kill).toHaveBeenCalledWith("SIGKILL");

    const secondFixture = createFixture();
    let oversizedChild;
    const oversizedSpawn = vi.fn(() => {
      oversizedChild = fakeChildProcess(({ child }) => {
        child.stdout.write(Buffer.alloc(1024 * 1024 + 1, 0x61));
      });
      return oversizedChild;
    });
    const oversizedVerifier = createVerifier(secondFixture, { spawnImpl: oversizedSpawn });
    await expect(oversizedVerifier.verify({
      packagePath: secondFixture.packagePath,
      expectedPackageId: "package-123",
      packageSha256: secondFixture.packageSha256,
      actionIds: ["idle", "sneeze", "roll", "sleep-transition", "sleep-loop", "stretch", "hover-attention"]
    })).rejects.toThrow(/output exceeded its limit/i);
    expect(oversizedChild.kill).toHaveBeenCalledWith("SIGKILL");

    const thirdFixture = createFixture();
    let erroredChild;
    const processErrorSpawn = vi.fn(() => {
      erroredChild = fakeChildProcess(() => {});
      queueMicrotask(() => erroredChild.emit("error", new Error("launch channel failed")));
      return erroredChild;
    });
    const processErrorVerifier = createVerifier(thirdFixture, { spawnImpl: processErrorSpawn });
    await expect(processErrorVerifier.verify({
      packagePath: thirdFixture.packagePath,
      expectedPackageId: "package-123",
      packageSha256: thirdFixture.packageSha256,
      actionIds: ["idle", "sneeze", "roll", "sleep-transition", "sleep-loop", "stretch", "hover-attention"]
    })).rejects.toThrow(/launch channel failed/i);
    expect(erroredChild.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("brands only factory-created verifiers for production delivery", () => {
    const fixture = createFixture();
    const upstreamVerifier = createPinnedUpstreamVerifier();
    const interactionVerifier = createAttestedVerifier(fixture);
    const validator = new PetpackDeliveryValidator({
      probeAsset: async () => ({}),
      originalImportVerifier: upstreamVerifier,
      interactionVerifier,
      productionMode: true
    });
    expect(validator.describe().productionAssured).toBe(true);
    expect(Object.isFrozen(upstreamVerifier)).toBe(true);
    expect(Object.isFrozen(interactionVerifier)).toBe(true);
    expect(Object.isFrozen(validator)).toBe(true);
    const boundValidate = validator.validate;
    expect(() => { validator.validate = async () => ({ ok: true }); }).toThrow();
    expect(validator.validate).toBe(boundValidate);

    expect(() => new PetpackDeliveryValidator({
      probeAsset: async () => ({}),
      originalImportVerifier: upstreamVerifier,
      interactionVerifier: { ...interactionVerifier },
      productionMode: true
    })).toThrow(/attested real Electron interaction runner/i);
  });

  it("rejects mutable execution hooks and environment injection at factory creation", () => {
    const fixture = createFixture();
    expect(() => createAttestedVerifier(fixture, {
      expectedRunnerSha256: "0".repeat(64)
    })).toThrow(/pinned checksum/i);
    expect(() => createAttestedVerifier(fixture, {
      childEnvironment: { NODE_OPTIONS: "--require attacker.js" }
    })).toThrow(/cannot set NODE_OPTIONS/i);
    expect(() => createAttestedVerifier(fixture, {
      electronExecutablePath: "relative-electron-runtime"
    })).toThrow(/absolute path/i);
    expect(() => createAttestedVerifier(fixture, {
      spawnImpl: respondingSpawn()
    })).toThrow(/does not accept a replacement process launcher/i);

    expect(() => createUpstreamImportVerifier({
      spawnImpl: respondingSpawn()
    })).toThrow(/does not accept replacement execution hooks/i);
    expect(() => createUpstreamImportVerifier({
      nodePath: process.execPath
    })).toThrow(/does not accept replacement execution hooks/i);

    const electronOptions = {
      electronExecutablePath: fixture.electronExecutablePath,
      expectedElectronExecutableSha256: fixture.expectedElectronExecutableSha256,
      runnerPath: fixture.runnerPath,
      expectedRunnerSha256: fixture.expectedRunnerSha256
    };
    Object.defineProperty(electronOptions, "spawnImpl", {
      enumerable: true,
      get() { throw new Error("replacement launcher getter must not run"); }
    });
    expect(() => createElectronInteractionVerifier(electronOptions))
      .toThrow(/does not accept a replacement process launcher/i);

    const upstreamOptions = {};
    Object.defineProperty(upstreamOptions, "nodePath", {
      enumerable: true,
      get() { throw new Error("replacement node path getter must not run"); }
    });
    expect(() => createUpstreamImportVerifier(upstreamOptions))
      .toThrow(/does not accept replacement execution hooks/i);

    expect(createAttestedVerifier(fixture, { identity: "  electron-runner@reviewed  " }).identity)
      .toBe("electron-runner@reviewed");
    expect(createPinnedUpstreamVerifier({ identity: "  clean-upstream@pinned  " }).identity)
      .toBe("clean-upstream@pinned");
  });
});
