"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabase/server";
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

export async function signInWithMagicLink(
  formData: FormData,
): Promise<AuthActionState> {
  const emailResult = emailSchema.safeParse(formData.get("email"));
  if (!emailResult.success)
    return { error: emailResult.error.issues[0].message };

  const supabase = getSupabaseServerClient();
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const { error } = await supabase.auth.signInWithOtp({
    email: emailResult.data,
    options: {
      emailRedirectTo: `${siteUrl}/auth/callback`,
    },
  });

  if (error) {
    return { error: "No se pudo enviar el email. Intenta más tarde." };
  }

  return { success: "Te enviamos un link al correo. Revisa tu bandeja." };
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

  cookies().set(ACTIVE_ORG_COOKIE, orgId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}
