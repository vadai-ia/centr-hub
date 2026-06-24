/**
 * Detección compartida del rate limit de envío de correos del SMTP built-in
 * de Supabase Free (2/hora). GoTrue devuelve el error en inglés
 * ("email rate limit exceeded" / "over_email_send_rate_limit"), así que sin
 * esta normalización el usuario veía un mensaje genérico con sufijo en inglés.
 *
 * Único lugar donde vive el mensaje en español: el reset de contraseña del
 * login (`requestPasswordReset`) y los flujos de Admin → Usuarios (invitar /
 * reenviar / vincular login) lo consumen para mostrar texto idéntico.
 */
export const EMAIL_RATE_LIMIT_MESSAGE =
  "Límite de envío de correos alcanzado (SMTP de Supabase Free). Espera ~1 h o configura SMTP propio.";

/** ¿El error de envío de correo es el rate limit del SMTP de Supabase? */
export function isEmailRateLimit(message: string | null | undefined): boolean {
  return /rate limit|too many|over_email_send_rate/i.test(message ?? "");
}
