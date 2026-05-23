import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const raw = await req.text();
    let body: unknown = null;
    try { body = JSON.parse(raw); } catch { body = null; }
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    const { error } = await getSupabaseAdminClient()
      .from("whaapy_raw_webhooks")
      .insert({ headers, body, raw_body: raw });
    if (error) {
      // eslint-disable-next-line no-console
      console.error("whaapy_raw_insert_failed", JSON.stringify(error));
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("whaapy_raw_unhandled", JSON.stringify(err, Object.getOwnPropertyNames(err)));
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
