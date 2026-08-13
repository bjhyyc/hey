export class StudioGatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "StudioGatewayError";
  }
}

const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._~-]*$/;

export function normalizeStudioPath(path: string | readonly string[]): string {
  const segments = typeof path === "string" ? path.split("/") : Array.from(path);
  const normalized = segments.filter(Boolean);
  let invalid = normalized.length === 0;
  for (const segment of normalized) {
    let decoded = "";
    try { decoded = decodeURIComponent(segment); } catch { invalid = true; }
    if (segment === "." || segment === ".." || !SAFE_SEGMENT.test(segment) || decoded !== segment) invalid = true;
  }
  if (invalid) {
    throw new StudioGatewayError("无效的服务路径", 400, "INVALID_GATEWAY_PATH");
  }
  return normalized.join("/");
}

export function browserStudioUrl(path: string | readonly string[]): string {
  return `/api/studio/${normalizeStudioPath(path)}`;
}

export async function browserStudioRequest<T>(
  path: string | readonly string[],
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body != null && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(browserStudioUrl(path), {
    ...init,
    headers,
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
