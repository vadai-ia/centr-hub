import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/pipeline";

  if (code) {
    // PKCE flow (magic link with code grant) — server-side exchange
    const cookieStore = cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          },
        },
      },
    );

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    return NextResponse.redirect(`${origin}/login?error=link_expired`);
  }

  // Implicit flow (invitations, recovery) — Supabase appends tokens as
  // '#access_token=...&type=invite'. Hash fragments are client-side only;
  // the server never receives them. Return HTML that reads the current hash
  // and navigates to /auth/confirm with the fragment preserved.
  return new Response(
    `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Verificando...</title><script>window.location.replace('/auth/confirm'+window.location.hash)</script></head><body>Verificando...</body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache",
      },
    },
  );
}
