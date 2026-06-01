"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ContactRow } from "@/lib/types/database";
import {
  updateContactWithPropagationAction,
  type EditContactResult,
} from "@/lib/actions/contacts";
import { formatAddress } from "../utils";

interface Props {
  contact: ContactRow;
  onSaved: (msg: string) => void;
}

/**
 * Form editable de información de contacto (M6 — B8).
 *
 * Comportamiento:
 *   - Pre-fillea los campos desde el `contact` recibido.
 *   - Botón "Guardar cambios" envía el form vía Server Action.
 *   - Toast inmediato al usuario. Propagaciones a Shopify y Whaapy
 *     corren en background (workers Inngest); si el dispatch falla,
 *     mostramos un mensaje informativo adicional sin bloquear.
 *   - `router.refresh()` tras éxito recarga el detalle desde el
 *     server (incluye LWW reconciliado y badge lead/cliente actualizado).
 *
 * Diseño: similar al `ContactFormReadonly` (mismo grid 2 columnas),
 * con inputs editables y un estado deshabilitado en `submitting`.
 */
export function ContactForm({ contact, onSaved }: Props) {
  const router = useRouter();
  const [fullName, setFullName] = useState(contact.full_name ?? "");
  const [email, setEmail] = useState(contact.email ?? "");
  const [phone, setPhone] = useState(contact.phone ?? "");
  const [address, setAddress] = useState(formatAddress(contact.address) ?? "");
  const [internalNote, setInternalNote] = useState(contact.internal_note ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setFullName(contact.full_name ?? "");
    setEmail(contact.email ?? "");
    setPhone(contact.phone ?? "");
    setAddress(formatAddress(contact.address) ?? "");
    setInternalNote(contact.internal_note ?? "");
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const result: EditContactResult = await updateContactWithPropagationAction({
      contactId: contact.id,
      fullName,
      email,
      phone,
      address,
      internalNote,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }

    if (result.propagationDispatchFailed) {
      onSaved(
        "Cambios guardados localmente. La sincronización con Shopify/Whaapy se reintentará automáticamente.",
      );
    } else if (result.missingPhoneCleared) {
      onSaved("Teléfono agregado. Se sincroniza con Shopify y Whaapy en segundo plano.");
    } else {
      onSaved("Cambios guardados.");
    }
    router.refresh();
  }

  const dirty =
    fullName !== (contact.full_name ?? "") ||
    email !== (contact.email ?? "") ||
    phone !== (contact.phone ?? "") ||
    address !== (formatAddress(contact.address) ?? "") ||
    internalNote !== (contact.internal_note ?? "");

  return (
    <section className="bg-white dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700">
      <header className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
          Información del contacto
        </h2>
        {dirty && !submitting && (
          <button
            type="button"
            onClick={reset}
            className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          >
            Descartar cambios
          </button>
        )}
      </header>
      <form onSubmit={handleSubmit} className="px-4 py-3 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
          <Field label="Nombre completo">
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              disabled={submitting}
              maxLength={200}
              className={inputClass}
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              maxLength={200}
              className={inputClass}
            />
          </Field>
          <Field
            label="Teléfono"
            hint={contact.missing_phone ? "Agregar teléfono creará el contacto en Whaapy." : undefined}
          >
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={submitting}
              maxLength={40}
              placeholder="+52 55 1234 5678"
              className={inputClass}
            />
          </Field>
          <Field label="Dirección">
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              disabled={submitting}
              maxLength={500}
              className={inputClass}
            />
          </Field>
        </div>
        <Field label="Nota interna">
          <textarea
            value={internalNote}
            onChange={(e) => setInternalNote(e.target.value)}
            disabled={submitting}
            maxLength={5000}
            rows={3}
            className={inputClass}
          />
        </Field>

        {error && (
          <div
            role="alert"
            className="px-3 py-2 rounded-md bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300 text-sm"
          >
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="submit"
            disabled={submitting || !dirty}
            className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300 disabled:cursor-not-allowed"
          >
            {submitting ? "Guardando..." : "Guardar cambios"}
          </button>
        </div>
      </form>
    </section>
  );
}

const inputClass =
  "w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
        {label}
      </span>
      {children}
      {hint && (
        <span className="block text-[11px] text-amber-700 dark:text-amber-300 mt-1">
          {hint}
        </span>
      )}
    </label>
  );
}
