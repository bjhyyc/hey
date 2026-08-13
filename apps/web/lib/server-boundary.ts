import "server-only";

import { normalizeStudioPath, StudioGatewayError } from "./studio-gateway-core";

const REQUEST_TIMEOUT_MS = 15_000;

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
    if (origin.username || origin.password || origin.search || origin.hash) {
      return { configured: false, reason: "服务端工作流地址无效" };
    }
    origin.pathname = `${origin.pathname.replace(/\/$/, "")}/`;
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

  const target = new URL(normalizeStudioPath(path), configuration.origin);
  const incoming = new URL(request.url);
  target.search = incoming.search;

  const headers = new Headers();
  for (const name of ["accept", "content-type", "cookie", "x-request-id"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${configuration.token}`);

  const body = new Set(["GET", "HEAD"]).has(request.method)
    ? undefined
    : await request.arrayBuffer();
  const response = await fetch(target, {
    method: request.method,
    headers,
    body,
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

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
