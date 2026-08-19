import { describe, expect, it, vi } from "vitest";
import { PetPackStudioService } from "../../platform/src/api/petpack-studio-service.js";

// A photograph 3010x4515 passed selection, passed the pre-check, took the
// payment, and then killed master generation with three dead retries, because
// nothing between the phone and the processor looked at pixel dimensions. The
// upload is refused here instead, while the customer can still replace it.

const ACTOR = { id: "11111111-1111-4111-8111-111111111111", role: "user", status: "active" };
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function buildService({ head, readThrows = false } = {}) {
  const acceptSourcePhoto = vi.fn(async () => ({ acceptedCount: 1, allAcceptedNow: false }));
  const repository = {
    getProjectBundle: vi.fn(async () => ({
      project: { id: PROJECT_ID, userId: ACTOR.id, species: "cat", state: "awaiting_photos" },
      order: { id: "order-1", projectId: PROJECT_ID, userId: ACTOR.id, status: "paid" }
    })),
    getRunByProject: vi.fn(async () => ({ id: "run-1", state: "awaiting_photos" })),
    getReservedSourcePhoto: vi.fn(async () => ({
      objectKey: "private/projects/p/source-photo/one.png",
      contentType: "image/png"
    })),
    acceptSourcePhoto,
    createProjectOrder: vi.fn(), listUserProjects: vi.fn(), reserveSourcePhoto: vi.fn(),
    getSourcePhotoRevision: vi.fn(), getCharacterCandidate: vi.fn(), getCharacterCandidates: vi.fn(),
    getDeliveryForProject: vi.fn(), authorizeDeliveryDownload: vi.fn(), markOrderPaymentState: vi.fn(),
    createPhotoPrecheck: vi.fn(), findPhotoPrecheckByFingerprint: vi.fn(), getPhotoPrecheck: vi.fn(),
    countRecentPhotoPrechecks: vi.fn(async () => 0)
  };
  const objectStore = {
    createUploadGrant: vi.fn(),
    createDownloadGrant: vi.fn(),
    archiveProviderOutput: vi.fn(),
    verifyUploadedObject: vi.fn(async () => ({ sha256: "a".repeat(64), byteSize: 4096 })),
    readObjectHead: vi.fn(async () => {
      if (readThrows) throw new Error("storage hiccup");
      return head;
    })
  };
  const service = new PetPackStudioService({
    repository,
    objectStore,
    paymentProvider: { createCheckout: vi.fn(), handleNotification: vi.fn(), queryStatus: vi.fn() },
    workflow: {
      startPaidOrder: vi.fn(), photosAccepted: vi.fn(),
      confirmCharacterMasters: vi.fn(), regenerateCharacterMaster: vi.fn()
    },
    logger: { info() {}, warn() {}, error() {} }
  });
  return { service, objectStore, acceptSourcePhoto };
}

const upload = (service) => service.confirmSourcePhotoUpload({
  actor: ACTOR, projectId: PROJECT_ID, ordinal: 1, sha256: "a".repeat(64), byteSize: 4096
});

describe("source photo dimension guard", () => {
  it("refuses a photo the master processor could not decode", async () => {
    const { service, acceptSourcePhoto } = buildService({ head: pngHeader(3010, 4515) });
    await expect(upload(service)).rejects.toMatchObject({ code: "source_photo_too_large" });
    await expect(upload(service)).rejects.toThrow(/4515/);
    expect(acceptSourcePhoto).not.toHaveBeenCalled();
  });

  it("accepts a photo inside the limit", async () => {
    const { service, acceptSourcePhoto } = buildService({ head: pngHeader(4096, 2160) });
    await expect(upload(service)).resolves.toEqual({ acceptedCount: 1 });
    expect(acceptSourcePhoto).toHaveBeenCalledTimes(1);
  });

  it("lets an unreadable header through rather than refusing a good upload", async () => {
    // A storage blip or an exotic container is not evidence of an oversized
    // photograph; the pipeline still gets to judge it.
    const { service, acceptSourcePhoto } = buildService({ readThrows: true });
    await expect(upload(service)).resolves.toEqual({ acceptedCount: 1 });
    expect(acceptSourcePhoto).toHaveBeenCalledTimes(1);
  });
});
