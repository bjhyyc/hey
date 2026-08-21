import { browserStudioUrl, StudioGatewayError } from "./studio-gateway-core";

export type AdminOperationItem = {
  lastActivityAt: string | null;
  order: { id?: string; amountFen?: number; createdAt?: string; updatedAt?: string };
  project: { id?: string; state?: string; updatedAt?: string };
  payment: { state?: string; method?: string; paidAt?: string };
  run: {
    id?: string;
    state?: string;
    hasFailure?: boolean;
    frontGenerationAttempts?: number;
    sideGenerationAttempts?: number;
    sleepGenerationAttempts?: number;
    updatedAt?: string;
  } | null;
  actions: Array<{ actionId?: string; state?: string; retryCount?: number; updatedAt?: string }>;
  delivery: { status?: string; downloadCount?: number; expiresAt?: string } | null;
  dispatch: { pending?: number; leased?: number; failed?: number; dead?: number };
  attention: { required: boolean; reasons: string[]; failedActionIds: string[] };
};

export type AdminQaSummary = { status: string | null; reasons: string[] } | null;

export type AdminRescueStage = { stage: string; mode: "rerun" | "regeneration_grant" };

export type AdminOrderDetail = {
  order: {
    id?: string; amountFen?: number; currency?: string; paymentMethod?: string;
    status?: string; paidAt?: string; deliveryStatus?: string; planCode?: string;
    createdAt?: string; updatedAt?: string;
  };
  project: { id?: string; displayName?: string; state?: string };
  run: {
    id?: string; state?: string; failureCode?: string | null;
    frontGenerationAttempts?: number; sideGenerationAttempts?: number; sleepGenerationAttempts?: number;
    frontUserRegenerationsUsed?: number; sideUserRegenerationsUsed?: number;
    frontQaRetries?: number; sideQaRetries?: number; updatedAt?: string;
  } | null;
  failedFromState: string | null;
  rescue: {
    adminRerunCount: number;
    maxAdminRerunsPerOrder: number;
    rerunBudgetExhausted: boolean;
    availableStages: AdminRescueStage[];
  };
  masters: Array<{
    id?: string; kind?: string; generationAttempt?: number; status?: string;
    lastErrorCode?: string; qa?: AdminQaSummary; previewUrl?: string; createdAt?: string;
  }>;
  actions: Array<{
    actionId?: string; state?: string; retryCount?: number;
    qa?: AdminQaSummary; previewUrl?: string; updatedAt?: string;
  }>;
  rejectedActionVideos: Array<{
    actionId?: string; assetId?: string; qa?: AdminQaSummary;
    rejectedAt?: string; previewUrl?: string;
  }>;
  delivery: { status?: string; downloadCount?: number; expiresAt?: string; assetRetained?: boolean } | null;
  dispatch: { pending?: number; leased?: number; failed?: number; dead?: number };
  timeline: Array<{ source?: string; at?: string; label?: string; detail?: string }>;
};

export type AdminRescueOutcome = {
  mode?: string;
  stage?: string;
  run?: { id?: string; state?: string };
  delivery?: { status?: string; expiresAt?: string; downloadCount?: number };
};

async function adminRequest<T>(
  path: string | readonly string[],
  { query, method = "GET", body }: { query?: Record<string, string>; method?: string; body?: unknown } = {},
): Promise<T> {
  let url = browserStudioUrl(path);
  if (query && Object.keys(query).length > 0) {
    url += `?${new URLSearchParams(query).toString()}`;
  }
  const headers = new Headers({ Accept: "application/json" });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | { error?: { code?: string; message?: string } }
    | T
    | null;
  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    throw new StudioGatewayError(
      error?.message || "服务暂时不可用，请稍后再试",
      response.status,
      error?.code || "GATEWAY_REQUEST_FAILED",
    );
  }
  return payload as T;
}

export const studioAdminApi = {
  attentionFeed: () =>
    adminRequest<{ items: AdminOperationItem[] }>(["admin", "operations"], {
      query: { status: "attention", limit: "20" },
    }),
  searchByOrderId: (orderId: string) =>
    adminRequest<{ items: AdminOperationItem[] }>(["admin", "orders"], { query: { orderId } }),
  searchByProjectId: (projectId: string) =>
    adminRequest<{ items: AdminOperationItem[] }>(["admin", "orders"], { query: { projectId } }),
  orderDetail: (orderId: string) =>
    adminRequest<AdminOrderDetail>(["admin", "orders", orderId]),
  rerunStage: (orderId: string, stage: string, reason: string) =>
    adminRequest<AdminRescueOutcome>(["admin", "orders", orderId, "rerun"], {
      method: "POST",
      body: { stage, reason },
    }),
  qaOverride: (orderId: string, stage: string, candidateId: string, reason: string) =>
    adminRequest<AdminRescueOutcome>(["admin", "orders", orderId, "qa-override"], {
      method: "POST",
      body: { stage, candidateId, reason },
    }),
  reissueDelivery: (orderId: string, reason: string) =>
    adminRequest<AdminRescueOutcome>(["admin", "orders", orderId, "delivery", "reissue"], {
      method: "POST",
      body: { reason },
    }),
};
