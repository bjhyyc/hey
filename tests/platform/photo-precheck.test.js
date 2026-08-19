import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const { PetPackStudioService } = require("../../platform/src/api/petpack-studio-service.js");
const { createPhotoPrecheckVisionClient } = require("../../platform/src/providers/photo-precheck-vision-client.js");

const ACTOR = { id: "11111111-1111-4111-8111-111111111111", role: "user", status: "active" };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function sha(seed) {
  return crypto.createHash("sha256").update(seed).digest("hex");
}

function photoSet(count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    ordinal: index + 1,
    originalSha256: sha(`photo-${index}`),
    dataUrl: PNG
  }));
}

function goodReport(count = 3) {
  return {
    photos: Array.from({ length: count }, (_, index) => ({
      ordinal: index + 1,
      pet_present: true,
      species_match: true,
      single_animal: true,
      full_body: true,
      view: index < 2 ? "front" : "side45",
      sharp: true,
      unobstructed: true,
      issue: ""
    })),
    same_animal: true
  };
}

function buildService({ report = goodReport(), enforced = false, stored = new Map(), counts = { value: 0 } } = {}) {
  const judgeSpy = vi.fn(async () => report);
  const visionClient = {
    configured: true,
    modelId: "test-vision-model",
    promptVersion: "pet-photo-precheck/v1",
    judgePhotoSet: judgeSpy
  };
  const repository = {
    createProjectOrder: vi.fn(async (input) => ({
      id: "order-1", projectId: "project-1", paymentMethod: input.paymentMethod,
      amountFen: 1, species: input.species
    })),
    listUserProjects: vi.fn(), getProjectBundle: vi.fn(), reserveSourcePhoto: vi.fn(),
    getReservedSourcePhoto: vi.fn(), acceptSourcePhoto: vi.fn(), getRunByProject: vi.fn(),
    getSourcePhotoRevision: vi.fn(), getCharacterCandidate: vi.fn(), getCharacterCandidates: vi.fn(),
    getDeliveryForProject: vi.fn(), authorizeDeliveryDownload: vi.fn(), markOrderPaymentState: vi.fn(),
    createPhotoPrecheck: vi.fn(async (row) => {
      const record = { id: `precheck-${stored.size + 1}`, createdAt: new Date().toISOString(), ...row };
      stored.set(row.fingerprint, record);
      counts.value += 1;
      return record;
    }),
    findPhotoPrecheckByFingerprint: vi.fn(async (fingerprint) => stored.get(fingerprint) || null),
    getPhotoPrecheck: vi.fn(async (id) => [...stored.values()].find((row) => row.id === id) || null),
    countRecentPhotoPrechecks: vi.fn(async () => counts.value)
  };
  const service = new PetPackStudioService({
    repository,
    paymentProvider: {
      createCheckout: vi.fn(async () => ({
        state: "pending", paymentMethod: "KAIPAY", provider: "kaipay",
        providerOrderId: "p1", nextAction: { type: "none" }, paymentChannel: "ALIPAY"
      })),
      handleNotification: vi.fn(), queryStatus: vi.fn()
    },
    objectStore: { createUploadGrant: vi.fn(), createDownloadGrant: vi.fn(), verifyUploadedObject: vi.fn() },
    workflow: { startPaidOrder: vi.fn(), photosAccepted: vi.fn(), confirmCharacterMasters: vi.fn(), regenerateCharacterMaster: vi.fn() },
    checkoutEnabled: true,
    precheckVisionClient: visionClient,
    photoPrecheckEnforced: enforced,
    precheckDailyLimit: 2,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  });
  return { service, repository, judgeSpy, stored };
}

describe("photo precheck service", () => {
  it("passes a clean set and stores the verdict", async () => {
    const { service, judgeSpy } = buildService();
    const result = await service.photoPrecheck({ actor: ACTOR, species: "cat", photos: photoSet() });
    expect(result.passed).toBe(true);
    expect(result.samePet).toBe(true);
    expect(result.verdicts).toHaveLength(3);
    expect(result.verdicts.every((verdict) => verdict.ok)).toBe(true);
    expect(result.remainingToday).toBe(1);
    expect(judgeSpy).toHaveBeenCalledTimes(1);
  });

  it("fails slots with reasons when the report finds problems", async () => {
    const report = goodReport();
    report.photos[0].pet_present = false;
    report.photos[2].view = "front";
    const { service } = buildService({ report });
    const result = await service.photoPrecheck({ actor: ACTOR, species: "cat", photos: photoSet() });
    expect(result.passed).toBe(false);
    expect(result.verdicts[0].ok).toBe(false);
    expect(result.verdicts[0].reasons.join("")).toContain("没有真实宠物");
    expect(result.verdicts[2].ok).toBe(false);
    expect(result.verdicts[2].reasons.join("")).toContain("侧面");
  });

  it("fails when the photos are not the same animal", async () => {
    const report = goodReport();
    report.same_animal = false;
    const { service } = buildService({ report });
    const result = await service.photoPrecheck({ actor: ACTOR, species: "dog", photos: photoSet() });
    expect(result.passed).toBe(false);
    expect(result.samePet).toBe(false);
  });

  it("serves an identical set from the stored verdict without a model call", async () => {
    const { service, judgeSpy } = buildService();
    const first = await service.photoPrecheck({ actor: ACTOR, species: "cat", photos: photoSet() });
    const second = await service.photoPrecheck({ actor: ACTOR, species: "cat", photos: photoSet() });
    expect(second.precheckId).toBe(first.precheckId);
    expect(judgeSpy).toHaveBeenCalledTimes(1);
  });

  it("exhausts the daily quota", async () => {
    const { service } = buildService();
    await service.photoPrecheck({ actor: ACTOR, species: "cat", photos: photoSet() });
    const other = photoSet();
    other[0] = { ...other[0], originalSha256: sha("different") };
    await service.photoPrecheck({ actor: ACTOR, species: "cat", photos: other });
    const third = photoSet();
    third[0] = { ...third[0], originalSha256: sha("third") };
    await expect(service.photoPrecheck({ actor: ACTOR, species: "cat", photos: third }))
      .rejects.toMatchObject({ code: "precheck_quota_exhausted" });
  });

  it("blocks checkout without a passing precheck when enforced", async () => {
    const { service } = buildService({ enforced: true });
    await expect(service.createCheckout({
      actor: ACTOR, planCode: "plan", displayName: "毛毛", paymentMethod: "KAIPAY",
      paymentChannel: "ALIPAY", idempotencyKey: "k1", species: "cat"
    })).rejects.toMatchObject({ code: "precheck_required" });
  });

  it("allows checkout with a fresh passing precheck when enforced", async () => {
    const { service } = buildService({ enforced: true });
    const pass = await service.photoPrecheck({ actor: ACTOR, species: "cat", photos: photoSet() });
    const checkout = await service.createCheckout({
      actor: ACTOR, planCode: "plan", displayName: "毛毛", paymentMethod: "KAIPAY",
      paymentChannel: "ALIPAY", idempotencyKey: "k1", species: "cat", precheckId: pass.precheckId
    });
    expect(checkout.order.id).toBe("order-1");
  });

  it("rejects a precheck belonging to another user at checkout", async () => {
    const { service, stored } = buildService({ enforced: true });
    const pass = await service.photoPrecheck({ actor: ACTOR, species: "cat", photos: photoSet() });
    stored.get([...stored.keys()][0]).userId = "22222222-2222-4222-8222-222222222222";
    await expect(service.createCheckout({
      actor: ACTOR, planCode: "plan", displayName: "毛毛", paymentMethod: "KAIPAY",
      paymentChannel: "ALIPAY", idempotencyKey: "k1", species: "cat", precheckId: pass.precheckId
    })).rejects.toMatchObject({ code: "precheck_required" });
  });
});

describe("photo precheck vision client", () => {
  it("reports unconfigured without registry credentials", () => {
    const client = createPhotoPrecheckVisionClient({ registry: { modelArk: { baseUrl: "", apiKey: "" } } });
    expect(client.configured).toBe(false);
  });

  it("falls back to json_object when json_schema is rejected", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.response_format.type);
      if (body.response_format.type === "json_schema") {
        return { status: 400, json: async () => ({ error: { code: "InvalidParameter" } }) };
      }
      return {
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(goodReport()) } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 }
        })
      };
    });
    const client = createPhotoPrecheckVisionClient({
      registry: { modelArk: { baseUrl: "https://example.test/api/v3", apiKey: "k", vision: { modelId: "m" } } },
      fetchImpl,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    const report = await client.judgePhotoSet({ species: "cat", photos: photoSet(), requestId: "r1" });
    expect(report.same_animal).toBe(true);
    expect(calls).toEqual(["json_schema", "json_object"]);
  });
});
