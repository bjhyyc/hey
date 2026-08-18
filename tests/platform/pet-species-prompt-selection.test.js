import { describe, expect, it } from "vitest";

import catalogModule from "../../platform/src/domain/action-catalog.js";
import stateMachineModule from "../../platform/src/domain/production-state-machine.js";
import httpModule from "../../platform/src/http/petpack-studio-http-api.js";

const { DEFAULT_PET_SPECIES, PET_SPECIES, assertPetSpecies } = catalogModule;
const { startProductionRun } = stateMachineModule;

const paidOrder = Object.freeze({
  id: "order-1",
  status: "paid",
  projectId: "project-1",
  amountFen: 1
});

describe("pet species domain", () => {
  it("supports exactly the two species the prompt sets cover", () => {
    expect(PET_SPECIES).toEqual(["dog", "cat"]);
    expect(DEFAULT_PET_SPECIES).toBe("dog");
  });

  it("rejects a species with no published prompt set", () => {
    expect(() => assertPetSpecies("rabbit")).toThrow(/Unsupported pet species/);
  });
});

describe("production run species", () => {
  it("freezes the species on the run so a run cannot switch prompt sets midway", () => {
    const run = startProductionRun({
      order: paidOrder,
      projectId: "project-1",
      runId: "run-1",
      modelRegistryVersion: "seedream-seedance-480p-v1",
      species: "cat"
    });

    expect(run.species).toBe("cat");
    expect(Object.isFrozen(run)).toBe(false);
  });

  it("defaults to the species every existing run was generated as", () => {
    const run = startProductionRun({
      order: paidOrder,
      projectId: "project-1",
      runId: "run-1",
      modelRegistryVersion: "seedream-seedance-480p-v1"
    });

    expect(run.species).toBe("dog");
  });

  it("refuses a run whose species has no prompt set", () => {
    expect(() => startProductionRun({
      order: paidOrder,
      projectId: "project-1",
      runId: "run-1",
      modelRegistryVersion: "seedream-seedance-480p-v1",
      species: "hamster"
    })).toThrow(/Unsupported pet species/);
  });
});

describe("checkout species contract", () => {
  const { createPetPackStudioHttpApi } = httpModule;

  function callCheckout(body) {
    const received = [];
    const service = {
      createCheckout: async (input) => {
        received.push(input);
        return {
          project: { id: "project-1" },
          order: { id: "order-1", status: "pending_payment", paymentMethod: "KAIPAY", amountFen: 1 },
          checkout: { paymentChannel: input.paymentChannel, nextAction: { type: "none" } }
        };
      },
      listProjects: async () => ({ items: [] }),
      refreshPaymentStatus: async () => ({}),
      createSourcePhotoUploadGrants: async () => [],
      confirmSourcePhotoUpload: async () => ({}),
      regenerateCharacterMaster: async () => ({}),
      confirmCharacter: async () => ({}),
      getProjectView: async () => ({}),
      createPetpackDownload: async () => ({}),
      handlePaymentNotification: async () => ({})
    };
    const api = createPetPackStudioHttpApi({
      service,
      resolveActor: async () => ({ userId: "user-1", roles: ["user"] })
    });
    return api.handle({ method: "POST", path: "/api/checkout", body }).then((response) => ({ response, received }));
  }

  const validBody = {
    planCode: "petpack-seven-action-v1",
    displayName: "Test pet",
    paymentMethod: "KAIPAY",
    paymentChannel: "ALIPAY",
    idempotencyKey: "checkout-species-1",
    species: "cat"
  };

  it("carries the chosen species into the service call", async () => {
    const { response, received } = await callCheckout(validBody);
    expect(response.status).toBe(201);
    expect(received[0].species).toBe("cat");
  });

  it("rejects a species outside the published prompt sets", async () => {
    const { response } = await callCheckout({ ...validBody, species: "ferret" });
    expect(response.status).toBe(400);
  });

  it("keeps taking orders from a web build that predates the species picker", async () => {
    const { species, ...withoutSpecies } = validBody;
    expect(species).toBe("cat");
    const { response, received } = await callCheckout(withoutSpecies);
    expect(response.status).toBe(201);
    expect(received[0].species).toBe("dog");
  });
});
