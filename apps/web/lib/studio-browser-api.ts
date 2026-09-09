import type { PetSpecies } from "@/lib/photo-slots";
import { browserStudioRequest } from "./studio-gateway-core";

export type ProjectSummary = {
  project: { id: string; displayName?: string; state?: string; updatedAt?: string };
  order: { id?: string; status?: string; paymentMethod?: string; amountFen?: number } | null;
  downloadReady: boolean;
  failed: boolean;
  nextStep?: string;
};

export type CharacterCandidate = {
  id: string;
  view: "front" | "side";
  previewUrl: string;
  canRegenerate: boolean;
  remainingRegenerations: number;
  // Every version generated for this view; empty until there is a choice.
  attempts: CharacterAttempt[];
};

export type CharacterAttempt = {
  id: string;
  generationAttempt: number;
  previewUrl: string;
  isCurrent: boolean;
};

export type ProjectView = {
  project: { id: string; displayName?: string; state?: string } | null;
  order: { id?: string; status?: string; paymentMethod?: string; amountFen?: number } | null;
  characterCandidates: {
    front: CharacterCandidate | null;
    side: CharacterCandidate | null;
    canConfirm: boolean;
  };
  // One bit, not the run's stage name: is a character master still being drawn
  // (so "coming shortly") or is the run long past that step?
  regeneratingCharacter?: boolean;
  progress: Array<{ id?: string; label?: string; state?: string }>;
  // What the pet will be able to do, and which of those is finished. The
  // server sends the customer's own list, never the clip composition.
  actionProgress?: {
    percent: number;
    items: Array<{ id: string; label: string; state: "done" | "working" | "waiting" }>;
  } | null;
  downloadReady: boolean;
  failed: boolean;
};

export type KaipayPaymentChannel = "ALIPAY" | "WXPAY";

export type KaipayNextAction =
  | { type: "redirect"; url: string }
  | { type: "qr_code"; qrCode?: string; qrCodeImageUrl?: string }
  | { type: "retry" | "poll"; retryAfterSeconds: number; message?: string }
  | { type: "none" };

export const studioBrowserApi = {
  session: () => browserStudioRequest<{ authenticated: boolean }>("auth/session"),
  exchangeSession: (accessToken: string) =>
    browserStudioRequest<{ authenticated: true; redirectTo: string }>("auth/cloudbase/session", {
      method: "POST",
      body: JSON.stringify({ accessToken }),
    }),
  logout: () => browserStudioRequest<{ authenticated: false }>("auth/logout", {
    method: "POST",
    body: JSON.stringify({}),
  }),
  listProjects: () =>
    browserStudioRequest<{ items: ProjectSummary[] }>("projects"),
  project: (projectId: string) =>
    browserStudioRequest<ProjectView>(["projects", projectId]),
  refreshPaymentStatus: (projectId: string) =>
    browserStudioRequest<{ order: { id?: string; status?: string }; nextAction?: KaipayNextAction }>(
      ["projects", projectId, "payment-status"],
      { method: "POST", body: JSON.stringify({}) },
    ),
  createCheckout: (input: { planCode: string; displayName: string; paymentMethod: string; paymentChannel: KaipayPaymentChannel; idempotencyKey: string; species: PetSpecies; precheckId?: string }) =>
    browserStudioRequest<{
      project: { id: string };
      order: { id: string; status: string; amountFen?: number };
      checkout: { paymentChannel?: KaipayPaymentChannel; nextAction?: KaipayNextAction };
    }>("checkout", { method: "POST", body: JSON.stringify(input) }),
  uploadGrants: (projectId: string, files: Array<{ contentType: string; sha256: string; byteSize: number }>) =>
    browserStudioRequest<Array<{ ordinal: number; uploadUrl: string; expiresInSeconds?: number }>>(
      ["projects", projectId, "photos", "upload-grants"],
      { method: "POST", body: JSON.stringify({ files }) },
    ),
  confirmPhoto: (projectId: string, ordinal: number, input: { sha256: string; byteSize: number }) =>
    browserStudioRequest<{ acceptedCount: number }>(["projects", projectId, "photos", String(ordinal), "confirm"], {
      method: "POST", body: JSON.stringify(input),
    }),
  regenerateCharacter: (projectId: string, view: "front" | "side") =>
    browserStudioRequest<{ accepted: boolean }>(["projects", projectId, "character", view, "regenerate"], {
      method: "POST", body: JSON.stringify({}),
    }),
  confirmCharacter: (projectId: string, frontMasterRevisionId: string, sideMasterRevisionId: string) =>
    browserStudioRequest<{ accepted: boolean }>(["projects", projectId, "character", "confirm"], {
      method: "POST", body: JSON.stringify({ frontMasterRevisionId, sideMasterRevisionId }),
    }),
  createDownload: (projectId: string) =>
    browserStudioRequest<{ downloadUrl: string; expiresInSeconds: number }>(["projects", projectId, "petpack-download"], {
      method: "POST", body: JSON.stringify({}),
    }),
};
