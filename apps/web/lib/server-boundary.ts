import "server-only";

import { platformStudioPath, StudioGatewayError } from "./studio-gateway-core";

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Per-route budgets for the known-long operations. A flat 15s cost real money
 * on r31's first day: the platform finished judging a photo pre-check
 * (precheck.vision_ok, ~15.0s at the edge) while this gateway had already
 * aborted at exactly 15s, so the customer saw "服务暂时不可用" and the vision
 * spend was discarded. The same shape of failure was latent on every route
 * whose downstream call carries its own 15s timeout (Kaipay checkout, order
 * query, refund): the provider may legitimately use all of its budget, and
 * the gateway must outlast downstream, not tie with it.
 */
const ROUTE_TIMEOUTS_MS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^\/api\/photo-precheck$/, 60_000],                       // vision model on 3-4 photos
  [/^\/api\/checkout$/, 35_000],                             // Kaipay create-order: its own 15s + platform work
  [/^\/api\/projects\/[^/]+\/payment-status$/, 35_000],      // Kaipay authoritative query: same shape
  [/^\/api\/admin\/orders\/[^/]+\/refund$/, 40_000],         // provider refund or query, plus commit
];

function requestTimeoutMs(path: string): number {
  for (const [pattern, budget] of ROUTE_TIMEOUTS_MS) {
    if (pattern.test(path)) return budget;
  }
  return REQUEST_TIMEOUT_MS;
}

export type StudioGatewayConfiguration =
  | { configured: true; origin: URL; token: string }
  | { configured: false; reason: string };

export function readStudioGatewayConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): StudioGatewayConfiguration {
  const rawOrigin = env.PETPACK_STUDIO_API_ORIGIN?.trim();
  const token = env.PETPACK_STUDIO_INTERNAL_TOKEN?.trim();
  if (!rawOrigin || !token) {
    return { configured: false, reason: "服务端工作流尚未配置" };
  }

  try {
    const origin = new URL(rawOrigin);
    const developmentLoopback = env.NODE_ENV !== "production" && origin.protocol === "http:" &&
      new Set(["127.0.0.1", "localhost"]).has(origin.hostname);
    if (origin.protocol !== "https:" && !developmentLoopback) {
      return { configured: false, reason: "服务端工作流地址无效" };
    }
    if (
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/"
    ) {
      return { configured: false, reason: "服务端工作流地址无效" };
    }
    return { configured: true, origin, token };
  } catch {
    return { configured: false, reason: "服务端工作流地址无效" };
  }
}

export function studioGatewayStatus(): { configured: boolean } {
  return { configured: readStudioGatewayConfiguration().configured };
}

export async function serverStudioRequest(
  path: string | readonly string[],
  request: Request,
): Promise<Response> {
  const configuration = readStudioGatewayConfiguration();
  if (!configuration.configured) {
    throw new StudioGatewayError(
      configuration.reason,
      503,
      "STUDIO_GATEWAY_NOT_CONFIGURED",
    );
  }

  const platformPath = platformStudioPath(path);
  const target = new URL(platformPath, configuration.origin);
  const incoming = new URL(request.url);
  target.search = incoming.search;

  const headers = new Headers();
  for (const name of ["accept", "content-type", "cookie", "x-request-id"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${configuration.token}`);
  // Attest the real customer address to the platform. Every request this
  // gateway relays leaves CloudBase through a shared egress IP, so without
  // this header the platform's per-client throttling would see the whole
  // customer base as one client. The platform trusts the header only from
  // callers holding the internal bearer above.
  const clientIp = request.headers.get("x-real-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? null;
  if (clientIp && clientIp.length <= 64 && /^[0-9a-fA-F.:]+$/.test(clientIp)) {
    headers.set("x-petpack-client-ip", clientIp);
  }

  const body = new Set(["GET", "HEAD"]).has(request.method)
    ? undefined
    : await request.arrayBuffer();

  // Every transport failure used to arrive at the browser as one sentence -
  // "服务暂时不可用，请稍后再试" - whether the platform had timed out, refused
  // the connection, or never been reachable. That sentence is what the r31
  // pre-check incident showed the customer, and diagnosing it meant reading
  // server logs. Name the failure instead: the customer learns whether waiting
  // helps, and the code reaches the console.
  const budgetMs = requestTimeoutMs(platformPath);
  let response: Response;
  try {
    response = await fetch(target, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(budgetMs),
    });
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new StudioGatewayError(
        `处理超时（超过 ${Math.round(budgetMs / 1000)} 秒），请稍后重试`,
        504,
        "STUDIO_GATEWAY_TIMEOUT",
      );
    }
    throw new StudioGatewayError(
      "无法连接服务，请稍后重试",
      502,
      "STUDIO_GATEWAY_UNREACHABLE",
    );
  }

  const outgoingHeaders = new Headers();
  for (const name of ["content-type", "set-cookie", "x-request-id", "retry-after"]) {
    const value = response.headers.get(name);
    if (value) outgoingHeaders.set(name, value);
  }
  outgoingHeaders.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    headers: outgoingHeaders,
  });
}
