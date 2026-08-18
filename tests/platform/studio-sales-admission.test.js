import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { PetPackStudioService } = require("../../platform/src/api/petpack-studio-service");
const { createPetPackStudioHttpApi } = require("../../platform/src/http/petpack-studio-http-api");

function repository() {
  return Object.fromEntries([
    "createProjectOrder", "listUserProjects", "getProjectBundle", "reserveSourcePhoto",
    "getReservedSourcePhoto", "acceptSourcePhoto", "getRunByProject", "getSourcePhotoRevision",
    "getCharacterCandidate", "getCharacterCandidates", "getDeliveryForProject",
    "authorizeDeliveryDownload", "markOrderPaymentState"
  ].map((method) => [method, vi.fn()]));
}

function paymentProvider() {
  return {
    createCheckout: vi.fn(),
    handleNotification: vi.fn(),
    queryStatus: vi.fn()
  };
}

function objectStore() {
  return {
    createUploadGrant: vi.fn(),
    createDownloadGrant: vi.fn(),
    verifyUploadedObject: vi.fn()
  };
}

function workflow() {
  return {
    startPaidOrder: vi.fn(),
    photosAccepted: vi.fn(),
    confirmCharacterMasters: vi.fn(),
    regenerateCharacterMaster: vi.fn()
  };
}

describe("Studio sales admission", () => {
  it("rejects a new paid order before creating local or provider records when sales are disabled", async () => {
    const store = repository();
    const provider = paymentProvider();
    const service = new PetPackStudioService({
      repository: store,
      paymentProvider: provider,
      objectStore: objectStore(),
      workflow: workflow(),
      checkoutEnabled: false,
      logger: { info: vi.fn() }
    });

    await expect(service.createCheckout({
      actor: { id: "user-1", role: "user" },
      planCode: "petpack-seven-action-v1",
      displayName: "Test pet",
      paymentMethod: "KAIPAY",
      paymentChannel: "ALIPAY",
      idempotencyKey: "checkout-disabled-1"
    })).rejects.toMatchObject({ code: "generation_sales_disabled" });
    expect(store.createProjectOrder).not.toHaveBeenCalled();
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });

  it("returns a stable 503 response at the HTTP boundary", async () => {
    const error = Object.assign(new Error("internal detail"), { code: "generation_sales_disabled" });
    const service = {
      createCheckout: vi.fn(async () => { throw error; }),
      listProjects: vi.fn(), refreshPaymentStatus: vi.fn(),
      createSourcePhotoUploadGrants: vi.fn(), confirmSourcePhotoUpload: vi.fn(),
      regenerateCharacterMaster: vi.fn(), confirmCharacter: vi.fn(), getProjectView: vi.fn(),
      createPetpackDownload: vi.fn(), handlePaymentNotification: vi.fn()
    };
    const api = createPetPackStudioHttpApi({
      service,
      resolveActor: vi.fn(async () => ({ userId: "user-1", roles: ["user"] }))
    });
    const result = await api.handle({
      method: "POST",
      path: "/api/checkout",
      body: {
        planCode: "petpack-seven-action-v1",
        displayName: "Test pet",
        paymentMethod: "KAIPAY",
        paymentChannel: "ALIPAY",
        idempotencyKey: "checkout-disabled-2",
        species: "dog"
      }
    });

    expect(result).toMatchObject({
      status: 503,
      body: { error: { code: "generation_sales_disabled", message: "新订单暂未开放，请稍后再试" } }
    });
  });
});
