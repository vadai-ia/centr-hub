"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSession, ACTIVE_ORG_COOKIE } from "@/lib/auth/session";

export type AuthActionState = { error?: string; success?: string };

const emailSchema = z.string().email("Email inválido");
const passwordSchema = z.string().min(1, "La contraseña es requerida");

export async function signInWithPassword(
  formData: FormData,
): Promise<AuthActionState> {
  const emailResult = emailSchema.safeParse(formData.get("email"));
  const passwordResult = passwordSchema.safeParse(formData.get("password"));

  if (!emailResult.success)
    return { error: emailResult.error.issues[0].message };
  if (!passwordResult.success)
    return { error: passwordResult.error.issues[0].message };

  const supabase = getSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: emailResult.data,
    password: passwordResult.data,
  });

  if (error) {
    return { error: "Email o contraseña incorrectos" };
  }

  redirect("/pipeline");
}

/**
 * Envía el link de recuperación de contraseña (Supabase built-in). Es el
 * único flujo de acceso sin contraseña conocido: el magic link
 * (`signInWithOtp`) se retiró porque su token de un solo uso lo consumen
 * los escáneres de correo (`otp_expired` al hacer click) — ver ERRORES.md.
 * El link aterriza en `/auth/confirm` (flujo implícito, type=recovery),
 * que ya muestra el formulario para definir contraseña nueva.
 * Respuesta genérica para no filtrar qué correos existen.
 */
export async function requestPasswordReset(
  formData: FormData,
): Promise<AuthActionState> {
  const emailResult = emailSchema.safeParse(formData.get("email"));
  if (!emailResult.success)
    return { error: emailResult.error.issues[0].message };

  const supabase = getSupabaseServerClient();
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const { error } = await supabase.auth.resetPasswordForEmail(
    emailResult.data,
    { redirectTo: `${siteUrl}/auth/confirm` },
  );

  if (error) {
    return { error: "No se pudo enviar el email. Intenta más tarde." };
  }

  return {
    success:
      "Si el correo está registrado, te enviamos un link para restablecer tu contraseña. Revisa tu bandeja.",
  };
}

export async function signOut(): Promise<void> {
  const supabase = getSupabaseServerClient();
  await supabase.auth.signOut();
  cookies().delete(ACTIVE_ORG_COOKIE);
  redirect("/login");
}

export async function switchOrganization(orgId: string): Promise<void> {
  const session = await getSession();
  if (session.status !== "ok") return;

  const isValid = session.data.orgs.some((o) => o.id === orgId);
  if (!isValid) return;

  // 1) Cookie SSR — fast-path para getSession() (sin RTT a Supabase Auth
  //    Admin en cada page load).
  cookies().set(ACTIVE_ORG_COOKIE, orgId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  // 2) Espejar la org activa en auth.users.app_metadata para que el
  //    Custom Access Token Hook (migración 0017) la inyecte como claim
  //    top-level `organization_id` en el siguiente JWT. updateUserById
  //    mergea app_metadata por construcción en supabase-js v2 (no
  //    reemplaza); otros campos como `provider` se preservan.
  const admin = getSupabaseAdminClient();
  try {
    await admin.auth.admin.updateUserById(session.data.userId, {
      app_metadata: { active_organization_id: orgId },
    });
  } catch (err) {
    // Si el write a auth.users falla, el cookie SSR queda correcto y
    // la app sigue operando server-side. El JWT del navegador NO
    // reflejará el switch hasta el próximo logout/login. Loguear
    // para diagnóstico en Vercel logs sin romper la UX.
    console.error(
      "[switchOrganization] failed to mirror active_organization_id to app_metadata",
      err,
    );
  }

  // 3) Forzar refresh del access_token — el hook se ejecuta y el JWT
  //    emitido lleva el claim actualizado. @supabase/ssr server client
  //    propaga las nuevas cookies sb-* en la respuesta automáticamente.
  //    Si refreshSession falla (sesión inválida, red), el próximo
  //    refresh natural (TTL del token) recoge el cambio.
  const supabase = getSupabaseServerClient();
  try {
    await supabase.auth.refreshSession();
  } catch (err) {
    console.error(
      "[switchOrganization] refreshSession failed; claim refresh deferred until next token refresh",
      err,
    );
  }
}
