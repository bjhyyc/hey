import { NextResponse } from "next/server";
import { studioGatewayStatus } from "@/lib/server-boundary";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      ok: true,
      service: "petpack-studio-web",
      gatewayConfigured: studioGatewayStatus().configured,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
