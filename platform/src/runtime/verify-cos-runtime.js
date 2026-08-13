const crypto = require("node:crypto");

const { createTencentCosPrivateObjectDriver } = require("../storage/tencent-cos-private-object-driver");
const { hydrateEnvironmentFromSecretFiles } = require("./load-secret-files");

const SMOKE_OBJECT_KEY = "private/system/cos-smoke-test-v1.txt";
const SMOKE_CONTENT_TYPE = "text/plain; charset=utf-8";
const SMOKE_BODY = Buffer.from("petpack-cos-smoke-test-v1\n", "utf8");

function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("A server-side fetch implementation is required");
  return fetchImpl;
}

async function requireSuccessfulResponse(response, operation) {
  if (!response || response.ok !== true) {
    const status = Number.isSafeInteger(response?.status) ? response.status : 0;
    throw new Error(`COS ${operation} failed with HTTP ${status}`);
  }
  return response;
}

async function runCosSmokeTest({ environment = process.env, driver, fetchImpl = globalThis.fetch } = {}) {
  const hydrated = hydrateEnvironmentFromSecretFiles({ environment });
  const storage = driver || createTencentCosPrivateObjectDriver({ environment: hydrated });
  const fetch = requireFetch(fetchImpl);
  const expectedSha256 = crypto.createHash("sha256").update(SMOKE_BODY).digest("hex");

  const upload = await storage.createSignedUpload({
    objectKey: SMOKE_OBJECT_KEY,
    contentType: SMOKE_CONTENT_TYPE,
    expiresInSeconds: 300
  });
  await requireSuccessfulResponse(await fetch(upload.url, {
    method: "PUT",
    headers: { "content-type": SMOKE_CONTENT_TYPE },
    body: SMOKE_BODY,
    redirect: "manual"
  }), "signed upload");

  const signedHead = await storage.headPrivate({ objectKey: SMOKE_OBJECT_KEY });
  if (signedHead.byteSize !== SMOKE_BODY.length || signedHead.sha256 !== expectedSha256 || signedHead.contentType !== SMOKE_CONTENT_TYPE) {
    throw new Error("COS signed upload verification did not match the fixed smoke object");
  }

  const serverWrite = await storage.putPrivate({
    objectKey: SMOKE_OBJECT_KEY,
    body: SMOKE_BODY,
    contentType: SMOKE_CONTENT_TYPE
  });
  if (serverWrite.byteSize !== SMOKE_BODY.length || serverWrite.sha256 !== expectedSha256) {
    throw new Error("COS server upload digest did not match the fixed smoke object");
  }

  const serverHead = await storage.headPrivate({ objectKey: SMOKE_OBJECT_KEY });
  if (serverHead.byteSize !== SMOKE_BODY.length || serverHead.sha256 !== expectedSha256 || serverHead.contentType !== SMOKE_CONTENT_TYPE) {
    throw new Error("COS server upload verification did not match the fixed smoke object");
  }

  const download = await storage.createSignedDownload({
    objectKey: SMOKE_OBJECT_KEY,
    expiresInSeconds: 300,
    disposition: "inline"
  });
  const downloadResponse = await requireSuccessfulResponse(await fetch(download.url, {
    method: "GET",
    redirect: "manual"
  }), "signed download");
  const downloaded = Buffer.from(await downloadResponse.arrayBuffer());
  if (!downloaded.equals(SMOKE_BODY)) throw new Error("COS signed download did not match the fixed smoke object");

  return Object.freeze({
    ok: true,
    objectKey: SMOKE_OBJECT_KEY,
    byteSize: SMOKE_BODY.length,
    sha256: expectedSha256
  });
}

async function main() {
  try {
    const result = await runCosSmokeTest();
    console.log(`cos_runtime=ok object=${result.objectKey} bytes=${result.byteSize} sha256=${result.sha256}`);
  } catch (error) {
    console.error(`cos_runtime=fail error=${error?.name || "Error"}`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = {
  SMOKE_BODY,
  SMOKE_CONTENT_TYPE,
  SMOKE_OBJECT_KEY,
  requireSuccessfulResponse,
  runCosSmokeTest
};
