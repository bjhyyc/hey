import { NextResponse } from "next/server";
import { serverStudioRequest } from "@/lib/server-boundary";
import { StudioGatewayError } from "@/lib/studio-gateway-core";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path: string[] }> };

function errorResponse(error: unknown): Response {
  if (error instanceof StudioGatewayError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: { "cache-control": "no-store" } },
    );
  }
  return NextResponse.json(
    { error: { code: "STUDIO_GATEWAY_UNAVAILABLE", message: "服务暂时不可用，请稍后再试" } },
    { status: 502, headers: { "cache-control": "no-store" } },
  );
}

async function proxy(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { path } = await context.params;
    return await serverStudioRequest(path, request);
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
