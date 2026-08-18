import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The confirmation endpoint validates its body with assertExactKeys against
// exactly {sha256, byteSize}. The upload-grant metadata additionally carries
// contentType, so forwarding that object verbatim makes every confirmation
// fail with invalid_request — which is exactly what shipped and blocked the
// first real order.
describe("photo upload confirmation payload", () => {
  const source = readFileSync(
    join(process.cwd(), "components", "PhotoUploadWorkflow.tsx"),
    "utf8"
  );

  it("never forwards the raw grant metadata to confirmPhoto", () => {
    expect(source).not.toMatch(/confirmPhoto\([^)]*metadata\[index\]\s*\)/);
  });

  it("sends exactly the two fields the confirmation endpoint accepts", () => {
    const call = source.slice(source.indexOf("confirmPhoto("));
    const body = call.slice(0, call.indexOf("});") + 3);
    expect(body).toContain("sha256: metadata[index].sha256");
    expect(body).toContain("byteSize: metadata[index].byteSize");
    expect(body).not.toContain("contentType");
  });
});
