import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const scriptPath = path.resolve("platform/docker/media-worker/assemble-runtime.sh");

describe("media runtime build contract", () => {
  it("fails closed when the assembled runtime contains libjxl", () => {
    const script = fs.readFileSync(scriptPath, "utf8");
    expect(script).toMatch(/refusing media runtime containing libjxl/);
    expect(script).toMatch(/grep -Eiq '[^']*libjxl/);
  });
});
