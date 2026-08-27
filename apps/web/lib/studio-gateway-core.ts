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

export function platformStudioPath(path: string | readonly string[]): string {
  const normalized = normalizeStudioPath(path);
  return normalized === "api" || normalized.startsWith("api/")
    ? `/${normalized}`
    : `/api/${normalized}`;
}

export function browserStudioUrl(path: string | readonly string[]): string {
  return `/api/studio/${normalizeStudioPath(path)}`;
}

/**
 * A response that carries no JSON error body still knows something the
 * customer can act on. Saying "服务暂时不可用" to a 413 or a 429 hides the one
 * fact that would let them fix it themselves, and hides it from the console
 * too - so the next report arrives with nothing to go on.
 */
function statusFallbackMessage(response: Response): string {
  switch (response.status) {
    case 401:
      return "登录状态已失效，请重新登录";
    case 403:
      return "没有权限执行此操作";
    case 404:
      return "请求的内容不存在";
    case 413:
      return "上传内容过大，请换更小的照片";
    case 429: {
      const retryAfter = Number(response.headers.get("retry-after"));
      return Number.isFinite(retryAfter) && retryAfter > 0
        ? `请求过于频繁，请 ${Math.ceil(retryAfter)} 秒后再试`
        : "请求过于频繁，请稍后再试";
    }
    case 504:
      return "处理超时，请稍后重试";
    default:
      return `服务暂时不可用（${response.status}），请稍后再试`;
  }
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
      error?.message || statusFallbackMessage(response),
      response.status,
      error?.code || "GATEWAY_REQUEST_FAILED",
    );
  }
  return payload as T;
}
