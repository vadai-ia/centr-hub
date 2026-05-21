import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_ROUTES = ["/login", "/auth/callback", "/auth/confirm", "/privacidad"];

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Refreshes the session token if expired — must call getUser, not getSession
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_ROUTES.some(
    (r) => pathname === r || pathname.startsWith(r + "/"),
  );

  if (!user && !isPublic) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Authenticated users are redirected away from login
  if (user && pathname === "/login") {
    return NextResponse.redirect(new URL("/pipeline", request.url));
  }

  return supabaseResponse;
}

export const config = {
  // Endpoints server-to-server (webhooks, Inngest) NO pasan por middleware:
  // no cargan cookies de sesión Supabase y serían redirigidos a /login
  // antes de llegar al handler. Otras rutas /api/* que sí requieren sesión
  // (data del dashboard, server actions) siguen cubiertas.
  matcher: [
    "/((?!api/webhooks|api/inngest|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
