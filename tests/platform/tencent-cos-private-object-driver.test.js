import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import cosDriverModule from "../../platform/src/storage/tencent-cos-private-object-driver.js";
import mediaWorkspaceModule from "../../platform/src/media/private-media-workspace.js";
import masterWorkspaceModule from "../../platform/src/media/private-master-image-workspace.js";
import petpackWorkspaceModule from "../../platform/src/petpack/private-petpack-workspace.js";

const {
  TencentCosPrivateObjectDriver,
  TencentCosPrivateObjectError
} = cosDriverModule;
const { PrivateMediaWorkspace } = mediaWorkspaceModule;
const { PrivateMasterImageWorkspace } = masterWorkspaceModule;
const { PrivatePetpackWorkspace } = petpackWorkspaceModule;

function driverConfig(overrides = {}) {
  return {
    bucket: "heyirmy-petpack-staging-1462360313",
    region: "ap-shanghai",
    secretId: "test-secret-id",
    secretKey: "test-secret-key",
    maxVerifiedObjectBytes: 32 * 1024 * 1024,
    maxArchiveObjectBytes: 256 * 1024 * 1024,
    ...overrides
  };
}

function responseHeaders({ body, contentType = "video/mp4", byteSize = body.length, etag = '"fixed-etag"' }) {
  return {
    "content-type": contentType,
    "content-length": String(byteSize),
    etag
  };
}

function fakeCos({
  body = Buffer.from("private-object"),
  chunks,
  headContentType = "video/mp4",
  headByteSize = body.length,
  responseContentType = headContentType,
  responseByteSize = headByteSize,
  getError
} = {}) {
  const getObjectUrl = vi.fn(() => {
    throw new Error("signed URL generation must not be used for server reads");
  });
  const headObject = vi.fn(async () => ({
    headers: responseHeaders({ body, contentType: headContentType, byteSize: headByteSize })
  }));
  const getObject = vi.fn((params, callback) => {
    const stream = new PassThrough();
    queueMicrotask(() => {
      if (getError) {
        stream.destroy(getError);
        callback(getError);
        return;
      }
      for (const chunk of chunks || [body]) stream.write(chunk);
      stream.end();
      setImmediate(() => callback(null, {
        headers: responseHeaders({ body, contentType: responseContentType, byteSize: responseByteSize })
      }));
    });
    return stream;
  });
  return {
    client: {
      getObjectUrl,
      headObject,
      getObject,
      putObject: vi.fn(async () => ({}))
    },
    getObjectUrl,
    headObject,
    getObject
  };
}

async function collect(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("Tencent COS private server reads", () => {
  it("streams a bounded private object with trusted metadata and never creates a signed URL", async () => {
    const chunks = [Buffer.from("private-"), Buffer.from("object")];
    const expected = Buffer.concat(chunks);
    const fake = fakeCos({ body: expected, chunks });
    const driver = new TencentCosPrivateObjectDriver({ config: driverConfig(), cosClient: fake.client });

    const downloaded = await driver.getPrivate({ objectKey: "private/project/run/action.mp4" });

    expect(downloaded).toMatchObject({
      objectKey: "private/project/run/action.mp4",
      contentType: "video/mp4",
      byteSize: expected.length
    });
    expect(downloaded).not.toHaveProperty("url");
    expect(Buffer.isBuffer(downloaded.body)).toBe(false);
    await expect(collect(downloaded.body)).resolves.toEqual(expected);
    expect(fake.getObjectUrl).not.toHaveBeenCalled();
    expect(fake.getObject).toHaveBeenCalledWith(expect.objectContaining({
      Bucket: driver.config.bucket,
      Region: driver.config.region,
      Key: "private/project/run/action.mp4",
      ReturnStream: true,
      Headers: { "If-Match": '"fixed-etag"' }
    }), expect.any(Function));
  });

  it("provides the server-side read contract required by all three private workspaces", () => {
    const fake = fakeCos();
    const driver = new TencentCosPrivateObjectDriver({ config: driverConfig(), cosClient: fake.client });
    const tempRoot = path.resolve(".tmp");

    expect(() => new PrivateMediaWorkspace({ driver, tempRoot })).not.toThrow();
    expect(() => new PrivateMasterImageWorkspace({ driver, tempRoot })).not.toThrow();
    expect(() => new PrivatePetpackWorkspace({ driver, tempRoot })).not.toThrow();
  });

  it("rejects an oversized object from HEAD before starting a download", async () => {
    const fake = fakeCos({ body: Buffer.from("123456"), headByteSize: 6 });
    const driver = new TencentCosPrivateObjectDriver({
      config: driverConfig({ maxArchiveObjectBytes: 5 }),
      cosClient: fake.client
    });

    await expect(driver.getPrivate({ objectKey: "private/project/run/large.bin" })).rejects.toMatchObject({
      name: "TencentCosPrivateObjectError",
      operation: "headObject",
      code: "private_object_too_large",
      category: "object_too_large"
    });
    expect(fake.getObject).not.toHaveBeenCalled();
    expect(fake.getObjectUrl).not.toHaveBeenCalled();
  });

  it("rejects invalid content metadata before starting a download", async () => {
    const fake = fakeCos({ headContentType: "not-a-content-type" });
    const driver = new TencentCosPrivateObjectDriver({ config: driverConfig(), cosClient: fake.client });

    await expect(driver.getPrivate({ objectKey: "private/project/run/invalid.bin" })).rejects.toMatchObject({
      code: "invalid_object_metadata",
      category: "invalid_response"
    });
    expect(fake.getObject).not.toHaveBeenCalled();
  });

  it("fails the stream when COS returns more or fewer bytes than HEAD recorded", async () => {
    const tooMany = fakeCos({ body: Buffer.from("123456"), headByteSize: 5, responseByteSize: 5 });
    const tooManyDriver = new TencentCosPrivateObjectDriver({ config: driverConfig(), cosClient: tooMany.client });
    const longDownload = await tooManyDriver.getPrivate({ objectKey: "private/project/run/long.bin" });
    await expect(collect(longDownload.body)).rejects.toMatchObject({
      code: "object_length_changed",
      category: "object_changed"
    });

    const tooFew = fakeCos({ body: Buffer.from("1234"), headByteSize: 5, responseByteSize: 5 });
    const tooFewDriver = new TencentCosPrivateObjectDriver({ config: driverConfig(), cosClient: tooFew.client });
    const shortDownload = await tooFewDriver.getPrivate({ objectKey: "private/project/run/short.bin" });
    await expect(collect(shortDownload.body)).rejects.toMatchObject({
      code: "object_length_changed",
      category: "object_changed"
    });
  });

  it("fails closed when GET metadata no longer matches HEAD", async () => {
    const fake = fakeCos({ responseContentType: "application/octet-stream" });
    const driver = new TencentCosPrivateObjectDriver({ config: driverConfig(), cosClient: fake.client });
    const downloaded = await driver.getPrivate({ objectKey: "private/project/run/action.mp4" });

    await expect(collect(downloaded.body)).rejects.toMatchObject({
      code: "object_metadata_changed",
      category: "object_changed"
    });
  });

  it("classifies provider failures without exposing provider messages or URLs", async () => {
    const getError = Object.assign(new Error("GET https://signed.example.invalid/?secret=leak"), {
      code: "NoSuchKey",
      statusCode: 404,
      RequestId: "request-id-1"
    });
    const fake = fakeCos({ getError });
    const driver = new TencentCosPrivateObjectDriver({ config: driverConfig(), cosClient: fake.client });
    const downloaded = await driver.getPrivate({ objectKey: "private/project/run/missing.bin" });
    let failure;
    try {
      await collect(downloaded.body);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TencentCosPrivateObjectError);
    expect(failure).toMatchObject({
      operation: "getObject",
      code: "NoSuchKey",
      category: "not_found",
      statusCode: 404,
      requestId: "request-id-1"
    });
    expect(failure.message).toBe("Tencent COS getObject failed");
    expect(failure.message).not.toContain("signed.example.invalid");
    expect(fake.getObjectUrl).not.toHaveBeenCalled();
  });
});
