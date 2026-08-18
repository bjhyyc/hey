"use strict";

// Build-time pin writer for the production Worker image. It records the
// checksums and frozen launcher configuration that the production component
// bundle later verifies at startup:
//
//   upstream-client-tree.sha256  package.json + package-lock.json + src tree
//   electron-executable.sha256   the reviewed xvfb launcher wrapper
//   electron-runner.sha256       the Electron interaction runner entry file
//   electron-binary.sha256       the real Electron binary (recorded evidence)
//   electron-runner-args.json    exactly the two pinned client arguments
//   electron-child-env.json      the frozen child process environment
//
// The tree checksum is computed by the runner's own exported
// checksumPinnedClientTree, so the pin can never drift from the algorithm the
// runner re-executes before every verification.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function requiredAbsolute(value, label) {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return value;
}

function sha256File(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    throw new Error(`${label} must be a regular non-empty file`);
  }
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function main() {
  const [clientRoot, electronBinaryPath, wrapperPath, runnerPath, outputDirectory] = process.argv.slice(2);
  requiredAbsolute(clientRoot, "Client root");
  requiredAbsolute(electronBinaryPath, "Electron binary path");
  requiredAbsolute(wrapperPath, "Electron wrapper path");
  requiredAbsolute(runnerPath, "Electron runner path");
  requiredAbsolute(outputDirectory, "Pin output directory");

  const runnerModule = require(runnerPath);
  if (typeof runnerModule.checksumPinnedClientTree !== "function") {
    throw new Error("Electron interaction runner does not export checksumPinnedClientTree");
  }
  const clientTree = runnerModule.checksumPinnedClientTree(clientRoot);

  fs.mkdirSync(outputDirectory, { recursive: true });
  const pins = {
    "upstream-client-tree.sha256": clientTree.sha256,
    "electron-executable.sha256": sha256File(wrapperPath, "Electron wrapper"),
    "electron-runner.sha256": sha256File(runnerPath, "Electron runner"),
    "electron-binary.sha256": sha256File(electronBinaryPath, "Electron binary"),
    "electron-runner-args.json": JSON.stringify([
      `--client-root=${clientTree.root}`,
      `--client-tree-sha256=${clientTree.sha256}`
    ]),
    "electron-child-env.json": JSON.stringify({
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/tmp",
      TMPDIR: "/tmp",
      ELECTRON_DISABLE_SANDBOX: "1"
    })
  };
  for (const [fileName, contents] of Object.entries(pins)) {
    fs.writeFileSync(path.join(outputDirectory, fileName), `${contents}\n`, { encoding: "utf8" });
  }
  process.stdout.write(`${JSON.stringify({
    clientRoot: clientTree.root,
    clientTreeSha256: clientTree.sha256,
    pinCount: Object.keys(pins).length
  })}\n`);
}

main();
