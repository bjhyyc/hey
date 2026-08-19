import { describe, expect, it, vi } from "vitest";
import { PetPackStudioService } from "../../platform/src/api/petpack-studio-service.js";

// Regenerating a master replaces what is on screen but keeps the earlier
// versions on record. An owner who spends their regenerations and finds the
// last one worse than the first must be able to keep the first, so the view
// carries every version and confirmation accepts any of them - not only the
// most recent.

const ACTOR = { id: "11111111-1111-4111-8111-111111111111", role: "user", status: "active" };
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function buildService() {
  const confirmCharacterMasters = vi.fn();
  const attempts = {
    front: [
      { id: "front-v1", generationAttempt: 1, objectKey: "private/p/awake-master/v1.png" },
      { id: "front-v2", generationAttempt: 2, objectKey: "private/p/awake-master/v2.png" },
      { id: "front-v3", generationAttempt: 3, objectKey: "private/p/awake-master/v3.png" }
    ],
    side: [{ id: "side-v1", generationAttempt: 1, objectKey: "private/p/sleep-master/v1.png" }]
  };
  const repository = {
    getProjectBundle: vi.fn(async () => ({
      project: { id: PROJECT_ID, userId: ACTOR.id, species: "cat", state: "awaiting_confirmation" },
      order: { id: "order-1", projectId: PROJECT_ID, userId: ACTOR.id, status: "paid" }
    })),
    getRunByProject: vi.fn(async () => ({
      id: "run-1", state: "awaiting_character_confirmation",
      frontUserRegenerationsUsed: 2, sideUserRegenerationsUsed: 0
    })),
    getCharacterCandidates: vi.fn(async () => ({
      front: { id: "front-v3", kind: "front", objectKey: "private/p/awake-master/v3.png" },
      side: { id: "side-v1", kind: "side", objectKey: "private/p/sleep-master/v1.png" }
    })),
    listCharacterCandidates: vi.fn(async (_projectId, view) => attempts[view]),
    // Confirmation looks a candidate up by id; an earlier attempt must resolve.
    getCharacterCandidate: vi.fn(async (_projectId, view, id) => {
      const match = attempts[view].find((attempt) => attempt.id === id);
      return match ? { ...match, kind: view, qaStatus: "passed" } : null;
    }),
    getDeliveryForProject: vi.fn(async () => null),
    listActionProgress: vi.fn(async () => []),
    createProjectOrder: vi.fn(), listUserProjects: vi.fn(), reserveSourcePhoto: vi.fn(),
    getReservedSourcePhoto: vi.fn(), acceptSourcePhoto: vi.fn(), getSourcePhotoRevision: vi.fn(),
    authorizeDeliveryDownload: vi.fn(), markOrderPaymentState: vi.fn(),
    createPhotoPrecheck: vi.fn(), findPhotoPrecheckByFingerprint: vi.fn(), getPhotoPrecheck: vi.fn(),
    countRecentPhotoPrechecks: vi.fn(async () => 0)
  };
  const service = new PetPackStudioService({
    repository,
    objectStore: {
      createUploadGrant: vi.fn(),
      createDownloadGrant: vi.fn(async ({ objectKey }) => ({ url: `https://signed/${objectKey}` })),
      verifyUploadedObject: vi.fn(),
      archiveProviderOutput: vi.fn()
    },
    paymentProvider: { createCheckout: vi.fn(), handleNotification: vi.fn(), queryStatus: vi.fn() },
    workflow: {
      startPaidOrder: vi.fn(), photosAccepted: vi.fn(),
      confirmCharacterMasters, regenerateCharacterMaster: vi.fn()
    },
    logger: { info() {}, warn() {}, error() {} }
  });
  return { service, confirmCharacterMasters };
}

describe("character master attempt choice", () => {
  it("offers every version once there is more than one", async () => {
    const { service } = buildService();
    const view = await service.getProjectView({ actor: ACTOR, projectId: PROJECT_ID });
    const front = view.characterCandidates.front;
    expect(front.attempts).toHaveLength(3);
    expect(front.attempts.map((attempt) => attempt.generationAttempt)).toEqual([1, 2, 3]);
    expect(front.attempts.filter((attempt) => attempt.isCurrent)).toHaveLength(1);
    expect(front.attempts.every((attempt) => attempt.previewUrl.startsWith("https://signed/"))).toBe(true);
  });

  it("offers no choice for a view generated only once", async () => {
    const { service } = buildService();
    const view = await service.getProjectView({ actor: ACTOR, projectId: PROJECT_ID });
    expect(view.characterCandidates.side.attempts).toEqual([]);
  });

  it("confirms an earlier version, not merely the latest", async () => {
    const { service, confirmCharacterMasters } = buildService();
    await service.confirmCharacter({
      actor: ACTOR,
      projectId: PROJECT_ID,
      frontMasterRevisionId: "front-v1",
      sideMasterRevisionId: "side-v1"
    });
    expect(confirmCharacterMasters).toHaveBeenCalledTimes(1);
    const call = confirmCharacterMasters.mock.calls[0][0];
    expect(JSON.stringify(call)).toContain("front-v1");
  });
});
