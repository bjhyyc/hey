import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const script = fs.readFileSync(path.join(rootDir, "ops/macos/install.sh"), "utf8");
const dockerfile = fs.readFileSync(path.join(rootDir, "apps/web/Dockerfile"), "utf8");

// The macOS install script and the download page both carry the archives'
// checksums and version: the script verifies a download against its copy, the
// page shows the customer its copy. They are the same numbers written twice,
// so this holds them together - a release that updates one and not the other
// would either refuse every install or advertise a checksum nothing matches.

function dockerArg(name) {
  const match = dockerfile.match(new RegExp(`^ARG ${name}=(.*)$`, "m"));
  return match ? match[1].trim() : "";
}

function scriptVar(name) {
  const match = script.match(new RegExp(`^${name}="([^"]*)"`, "m"));
  return match ? match[1] : "";
}

describe("macOS install script", () => {
  test("verifies the same archives the download page advertises", () => {
    expect(scriptVar("SHA_ARM64")).toMatch(/^[a-f0-9]{64}$/);
    expect(scriptVar("SHA_ARM64")).toBe(dockerArg("NEXT_PUBLIC_MACOS_CLIENT_ARM64_SHA256"));
    expect(scriptVar("SHA_X64")).toBe(dockerArg("NEXT_PUBLIC_MACOS_CLIENT_X64_SHA256"));
    expect(scriptVar("VERSION")).toBe(dockerArg("NEXT_PUBLIC_MACOS_CLIENT_VERSION"));
  });

  test("downloads from the bucket the page links to", () => {
    const base = scriptVar("COS_BASE_URL");
    expect(base).toMatch(/^https:\/\//);
    expect(dockerArg("NEXT_PUBLIC_MACOS_CLIENT_ARM64_URL")).toBe(`${base}/Hey-${scriptVar("VERSION")}-arm64-mac.zip`);
    expect(dockerArg("NEXT_PUBLIC_MACOS_CLIENT_X64_URL")).toBe(`${base}/Hey-${scriptVar("VERSION")}-mac.zip`);
    expect(dockerArg("NEXT_PUBLIC_MACOS_INSTALL_SCRIPT_URL")).toBe(`${base}/install.sh`);
  });

  test("fails closed on a bad download and never touches anything but the app", () => {
    // -f so an HTTP error is an error, not an error page saved as the archive.
    expect(script).toMatch(/curl -fL/);
    // The checksum is compared before anything is unpacked or installed.
    expect(script.indexOf("shasum -a 256")).toBeLessThan(script.indexOf("unzip"));
    // Quarantine removal and the ad-hoc signature are scoped to the bundle.
    expect(script).toContain('xattr -cr "$INSTALL_PATH"');
    expect(script).toContain('codesign --force --deep --sign - "$INSTALL_PATH"');
    expect(script).not.toMatch(/xattr -cr \/Applications\s*$/m);
    // Nothing in it needs bash 4; macOS ships 3.2.
    expect(script).not.toMatch(/\[\[|declare -A|mapfile|readarray/);
    // And no upstream project anywhere near what a customer runs.
    expect(script).not.toMatch(/duzexu|desktop-pet/i);
  });
});
