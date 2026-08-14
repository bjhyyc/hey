import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { describe, expect, it } from "vitest";

import localDriverModule from "../../platform/src/storage/local-private-object-driver.js";

const {
  LocalPrivateObjectDriver,
  LocalPrivateObjectHttpServer,
  createLocalPrivateObjectDriver,
  loadLocalPrivateObjectConfig
} = localDriverModule;

const TEST_SECRET = "local-object-test-secret-that-is-longer-than-thirty-two-bytes";

function uniqueRoot(label) {
  return path.resolve(".tmp", `local-object-${label}-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
}

function driver(rootDirectory, overrides = {}) {
  return new LocalPrivateObjectDriver({
    rootDirectory,
    signingSecret: TEST_SECRET,
    environmentName: "test",
    ...overrides
  });
}

function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

async function collect(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function replaceDirectory(directory, label) {
  const moved = `${directory}-${label}-${crypto.randomUUID()}`;
  await fs.rename(directory, moved);
  await fs.mkdir(directory);
  return moved;
}

describe("local private object driver", () => {
  it("fails closed outside development/test and rejects non-loopback signing origins", () => {
    const rootDirectory = uniqueRoot("fail-closed");
    expect(() => driver(rootDirectory, { environmentName: "production" })).toThrow(/configure failed/i);
    expect(() => driver(rootDirectory, {
      environmentName: "development",
      testHooks: { putBeforeFinalParentCheck() {} }
    })).toThrow(/test hooks are permitted only in test mode/i);
    expect(() => driver(rootDirectory, { baseUrl: "http://192.0.2.10:18080" })).toThrow(/loopback/i);
    expect(() => loadLocalPrivateObjectConfig({
      NODE_ENV: "production",
      PETPACK_LOCAL_OBJECT_ROOT: rootDirectory,
      PETPACK_LOCAL_OBJECT_SIGNING_SECRET: TEST_SECRET,
      PETPACK_LOCAL_OBJECT_BASE_URL: "http://127.0.0.1:18080"
    })).toThrow(/configure failed/i);
  });

  it("shares immutable objects and trusted metadata across independent driver instances", async () => {
    const rootDirectory = uniqueRoot("cross-instance");
    const writer = driver(rootDirectory);
    const reader = driver(rootDirectory);
    const body = Buffer.from("shared-across-process-shaped-instances");
    const objectKey = "private/projects/project-1/runs/run-1/provider-output/action.mp4";

    await expect(writer.putPrivate({
      objectKey,
      body,
      contentType: "video/mp4",
      sha256: sha256(body),
      byteSize: body.length,
      ifNoneMatch: "*"
    })).resolves.toEqual({
      objectKey,
      contentType: "video/mp4",
      sha256: sha256(body),
      byteSize: body.length
    });

    await expect(reader.headPrivate({ objectKey })).resolves.toEqual({
      objectKey,
      contentType: "video/mp4",
      sha256: sha256(body),
      byteSize: body.length
    });
    const downloaded = await reader.getPrivate({ objectKey });
    await expect(collect(downloaded.body)).resolves.toEqual(body);
    await expect(reader.putPrivate({
      objectKey,
      body,
      contentType: "video/mp4",
      ifNoneMatch: "*"
    })).rejects.toMatchObject({ code: "precondition_failed", category: "conflict" });
  });

  it("serves HMAC-signed PUT/GET with MIME, size, digest, ETag and immutable-write enforcement", async () => {
    const rootDirectory = uniqueRoot("signed-http");
    const serverDriver = driver(rootDirectory);
    const server = new LocalPrivateObjectHttpServer({
      driver: serverDriver,
      allowedOrigins: ["http://localhost:3000"]
    });
    const listening = await server.start();
    const remoteDriver = driver(rootDirectory, { baseUrl: listening.origin });
    const body = Buffer.from("signed-http-object");
    const objectKey = "private/projects/project-2/runs/run-2/source-photo/front.jpg";

    try {
      const upload = remoteDriver.createSignedUpload({
        objectKey,
        contentType: "image/jpeg",
        expectedSha256: sha256(body),
        expectedByteSize: body.length,
        expiresInSeconds: 60
      });
      const preflight = await fetch(upload.url, {
        method: "OPTIONS",
        headers: { origin: "http://localhost:3000", "access-control-request-method": "PUT" }
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");

      const uploaded = await fetch(upload.url, {
        method: "PUT",
        headers: { "content-type": upload.headers["content-type"], origin: "http://localhost:3000" },
        body
      });
      expect(uploaded.status).toBe(201);
      expect(uploaded.headers.get("etag")).toBe(`"${sha256(body)}"`);
      expect(await uploaded.json()).toMatchObject({ objectKey, contentType: "image/jpeg", byteSize: body.length, sha256: sha256(body) });

      const download = remoteDriver.createSignedDownload({ objectKey, disposition: "inline", expiresInSeconds: 60 });
      const fetched = await fetch(download.url);
      expect(fetched.status).toBe(200);
      expect(fetched.headers.get("content-type")).toBe("image/jpeg");
      expect(fetched.headers.get("content-length")).toBe(String(body.length));
      expect(fetched.headers.get("content-disposition")).toBe("inline");
      expect(Buffer.from(await fetched.arrayBuffer())).toEqual(body);

      const unchanged = await fetch(download.url, { headers: { "if-none-match": `"${sha256(body)}"` } });
      expect(unchanged.status).toBe(304);
      expect(await unchanged.text()).toBe("");

      const duplicate = await fetch(upload.url, { method: "PUT", headers: upload.headers, body });
      expect(duplicate.status).toBe(412);
      expect(await remoteDriver.headPrivate({ objectKey })).toMatchObject({ sha256: sha256(body), byteSize: body.length });
    } finally {
      await server.close();
    }
  });

  it("rejects tampered, expired, wrong-MIME and wrong-digest uploads without committing an object", async () => {
    const rootDirectory = uniqueRoot("signed-rejections");
    let now = Date.now();
    const clock = () => now;
    const serverDriver = driver(rootDirectory, { now: clock });
    const server = new LocalPrivateObjectHttpServer({ driver: serverDriver });
    const listening = await server.start();
    const remoteDriver = driver(rootDirectory, { baseUrl: listening.origin, now: clock });
    const body = Buffer.from("right");
    const objectKey = "private/projects/project-3/runs/run-3/source-photo/front.jpg";

    try {
      const upload = remoteDriver.createSignedUpload({
        objectKey,
        contentType: "image/jpeg",
        expectedSha256: sha256(body),
        expectedByteSize: body.length,
        expiresInSeconds: 1
      });
      const tampered = new URL(upload.url);
      const validSignature = tampered.searchParams.get("signature");
      tampered.searchParams.set("signature", `${validSignature.slice(0, 63)}${validSignature.endsWith("0") ? "1" : "0"}`);
      expect((await fetch(tampered, { method: "PUT", headers: upload.headers, body })).status).toBe(403);

      expect((await fetch(upload.url, {
        method: "PUT",
        headers: { "content-type": "image/png", "if-none-match": "*" },
        body
      })).status).toBe(400);

      expect((await fetch(upload.url, {
        method: "PUT",
        headers: upload.headers,
        body: Buffer.from("wrong")
      })).status).toBe(422);
      await expect(remoteDriver.headPrivate({ objectKey })).rejects.toMatchObject({ code: "object_not_found" });

      now += 2_000;
      expect((await fetch(upload.url, { method: "PUT", headers: upload.headers, body })).status).toBe(403);
      await expect(remoteDriver.headPrivate({ objectKey })).rejects.toMatchObject({ code: "object_not_found" });
    } finally {
      await server.close();
    }
  });

  it("rejects traversal-shaped keys and a symlinked object shard", async () => {
    const rootDirectory = uniqueRoot("path-safety");
    const local = driver(rootDirectory);
    const body = Buffer.from("path-safe");
    expect(() => local.createSignedUpload({
      objectKey: "private/projects/../outside.bin",
      contentType: "application/octet-stream",
      expectedSha256: sha256(body),
      expectedByteSize: body.length
    })).toThrow(/safe private object keys/i);

    await local.initialize();
    const objectKey = "private/projects/project-4/runs/run-4/provider-output/result.bin";
    const digest = sha256(Buffer.from(objectKey));
    const outside = path.join(rootDirectory, "outside");
    const shard = path.join(rootDirectory, "objects", digest.slice(0, 2));
    await fs.mkdir(outside, { recursive: true });
    let linked = true;
    try {
      await fs.symlink(outside, shard, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
      linked = false;
    }
    if (linked) {
      await expect(local.putPrivate({
        objectKey,
        body,
        contentType: "application/octet-stream",
        ifNoneMatch: "*"
      })).rejects.toMatchObject({ code: "unsafe_storage_path", category: "access_denied" });
    }
  });

  it("fails closed and removes only its staging directory when the destination parent changes before rename", async () => {
    const rootDirectory = uniqueRoot("put-parent-race");
    let hookRan = false;
    const local = driver(rootDirectory, {
      testHooks: {
        async putBeforeFinalParentCheck({ paths }) {
          hookRan = true;
          await replaceDirectory(paths.shardDirectory, "before-rename");
        }
      }
    });
    const body = Buffer.from("parent-race-before-rename");
    const objectKey = "private/projects/project-race/runs/run-1/provider-output/result.bin";

    await expect(local.putPrivate({
      objectKey,
      body,
      contentType: "application/octet-stream",
      sha256: sha256(body),
      byteSize: body.length,
      ifNoneMatch: "*"
    })).rejects.toMatchObject({ code: "storage_path_changed", category: "access_denied" });
    expect(hookRan).toBe(true);
    expect((await fs.readdir(path.join(rootDirectory, "staging"))).filter((entry) => entry.startsWith("object-"))).toEqual([]);
  });

  it("revalidates the committed record and fails closed when its parent changes immediately after rename", async () => {
    const rootDirectory = uniqueRoot("put-post-rename-race");
    let hookRan = false;
    const local = driver(rootDirectory, {
      testHooks: {
        async putAfterRenameBeforeValidation({ paths }) {
          hookRan = true;
          await replaceDirectory(paths.shardDirectory, "after-rename");
        }
      }
    });
    const body = Buffer.from("parent-race-after-rename");

    await expect(local.putPrivate({
      objectKey: "private/projects/project-race/runs/run-2/provider-output/result.bin",
      body,
      contentType: "application/octet-stream",
      sha256: sha256(body),
      byteSize: body.length,
      ifNoneMatch: "*"
    })).rejects.toMatchObject({ code: "storage_path_changed", category: "access_denied" });
    expect(hookRan).toBe(true);
    expect((await fs.readdir(path.join(rootDirectory, "staging"))).filter((entry) => entry.startsWith("object-"))).toEqual([]);
  });

  it("fails closed when the record parent changes between metadata and body reads", async () => {
    const rootDirectory = uniqueRoot("read-parent-race");
    const objectKey = "private/projects/project-race/runs/run-3/provider-output/result.bin";
    const body = Buffer.from("read-parent-race");
    const seed = driver(rootDirectory);
    await seed.putPrivate({
      objectKey,
      body,
      contentType: "application/octet-stream",
      sha256: sha256(body),
      byteSize: body.length,
      ifNoneMatch: "*"
    });
    let hookRan = false;
    const reader = driver(rootDirectory, {
      testHooks: {
        async readBeforeBodyOpen({ paths }) {
          hookRan = true;
          await replaceDirectory(paths.shardDirectory, "during-read");
        }
      }
    });

    await expect(reader.getPrivate({ objectKey })).rejects.toMatchObject({
      code: "storage_path_changed",
      category: "access_denied"
    });
    expect(hookRan).toBe(true);
  });

  it("supports the async environment factory and its explicit server ownership", async () => {
    const rootDirectory = uniqueRoot("factory");
    const created = await createLocalPrivateObjectDriver({
      environment: {
        NODE_ENV: "test",
        PETPACK_LOCAL_OBJECT_ROOT: rootDirectory,
        PETPACK_LOCAL_OBJECT_SIGNING_SECRET: TEST_SECRET,
        PETPACK_LOCAL_OBJECT_BASE_URL: "http://127.0.0.1:18991",
        PETPACK_LOCAL_OBJECT_SERVE: "0"
      }
    });
    expect(created).toBeInstanceOf(LocalPrivateObjectDriver);
    expect(created.httpServer).toBeUndefined();
    await expect(created.close()).resolves.toBeUndefined();

    const servingRoot = uniqueRoot("factory-server");
    const port = await reserveLoopbackPort();
    const serving = await createLocalPrivateObjectDriver({
      environment: {
        NODE_ENV: "test",
        PETPACK_LOCAL_OBJECT_ROOT: servingRoot,
        PETPACK_LOCAL_OBJECT_SIGNING_SECRET: TEST_SECRET,
        PETPACK_LOCAL_OBJECT_BASE_URL: `http://127.0.0.1:${port}`,
        PETPACK_LOCAL_OBJECT_SERVE: "1",
        PETPACK_LOCAL_OBJECT_ALLOWED_ORIGINS: "http://localhost:3000"
      }
    });
    try {
      expect(serving.httpServer).toBeInstanceOf(LocalPrivateObjectHttpServer);
      const body = Buffer.from("factory-owned-server");
      const upload = serving.createSignedUpload({
        objectKey: "private/projects/project-5/runs/run-5/source-photo/front.jpg",
        contentType: "image/jpeg",
        expectedSha256: sha256(body),
        expectedByteSize: body.length
      });
      expect((await fetch(upload.url, { method: "PUT", headers: upload.headers, body })).status).toBe(201);
    } finally {
      await serving.close();
    }
  });
});
