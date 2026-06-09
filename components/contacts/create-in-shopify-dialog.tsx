"use client";
import { useEffect, useRef, useState } from "react";
import {
  createContactInShopifyAction,
  type CreateInShopifyResult,
} from "@/lib/actions/contacts";
import {
  emptyStructuredAddress,
  type StructuredAddress,
} from "@/lib/contacts/address";
import { StructuredAddressFields } from "@/components/contacts/structured-address-fields";
import type { UUID } from "@/lib/types/database";

export interface CreateInShopifyPrefill {
  contactId: UUID;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  /** Dirección estructurada del maestro (ya parseada). */
  address: StructuredAddress;
}

interface Props {
  open: boolean;
  prefill: CreateInShopifyPrefill | null;
  onCancel: () => void;
  /**
   * Llamado al cerrar el modal tras un guardado exitoso. El caller
   * típicamente refresca la pantalla para reflejar la transición
   * lead → cliente (router.refresh / re-fetch del bundle).
   */
  onSuccess: (result: { shopifyCustomerId: string; alreadyExisted: boolean }) => void;
}

/**
 * Modal "Crear contacto en Shopify" (M6 — B6).
 *
 * Patrón visual idéntico a `LossReasonModal` de M5 (backdrop click
 * cancela, ESC cancela, focus management). Form con campos editables
 * pre-llenados desde el contacto maestro.
 *
 * Defensa: el botón principal no se habilita sin teléfono — el match
 * defensivo del outbound de Shopify exige teléfono normalizado.
 */
export function CreateInShopifyDialog({
  open,
  prefill,
  onCancel,
  onSuccess,
}: Props) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState<StructuredAddress>(
    emptyStructuredAddress(),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Pre-fill cuando se abre con nuevos datos.
  useEffect(() => {
    if (!open || !prefill) {
      setFirstName("");
      setLastName("");
      setEmail("");
      setPhone("");
      setAddress(emptyStructuredAddress());
      setError(null);
      setSubmitting(false);
      return;
    }
    const { first, last } = splitName(prefill.fullName);
    setFirstName(first);
    setLastName(last);
    setEmail(prefill.email ?? "");
    setPhone(prefill.phone ?? "");
    // La dirección hereda nombre del contacto si no trae uno propio.
    setAddress({
      ...prefill.address,
      first_name: prefill.address.first_name || first,
      last_name: prefill.address.last_name || last,
    });
    setError(null);
  }, [open, prefill]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onCancel();
    }
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting, onCancel]);

  if (!open || !prefill) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!prefill || submitting) return;
    setSubmitting(true);
    setError(null);
    const result: CreateInShopifyResult = await createContactInShopifyAction({
      contactId: prefill.contactId,
      firstName: firstName.trim() || undefined,
      lastName: lastName.trim() || undefined,
      email: email.trim() || undefined,
      phone: phone.trim(),
      address,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onSuccess({
      shopifyCustomerId: result.shopifyCustomerId,
      alreadyExisted: result.alreadyExisted,
    });
  }

  const phoneOk = phone.trim().length >= 4;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-shopify-title"
      onClick={submitting ? undefined : onCancel}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full p-6 outline-none max-h-[90vh] overflow-y-auto"
      >
        <p
          id="create-shopify-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          Crear contacto en Shopify
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Si Shopify ya tiene un customer con este teléfono, no se
          duplica: se enlaza el customer existente al contacto.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Nombre">
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                disabled={submitting}
                maxLength={100}
                autoFocus
                className={inputClass}
              />
            </Field>
            <Field label="Apellido">
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                disabled={submitting}
                maxLength={100}
                className={inputClass}
              />
            </Field>
          </div>

          <Field label="Email">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              maxLength={200}
              placeholder="opcional"
              className={inputClass}
            />
          </Field>

          <Field
            label={
              <span>
                Teléfono <span className="text-red-600 dark:text-red-400">*</span>
              </span>
            }
            hint="Formato internacional. Ej: +52 55 1234 5678"
          >
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={submitting}
              maxLength={40}
              required
              className={inputClass}
            />
          </Field>

          <div className="pt-1">
            <span className="block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
              Dirección <span className="font-normal normal-case">(opcional)</span>
            </span>
            <StructuredAddressFields
              value={address}
              onChange={setAddress}
              disabled={submitting}
              idPrefix="shopify-addr"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="px-3 py-2 rounded-md bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300 text-sm"
            >
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting || !phoneOk}
              className="px-3 py-1.5 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-300 disabled:cursor-not-allowed"
            >
              {submitting ? "Creando..." : "Crear en Shopify"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputClass =
  "w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50";

function Field({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
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
        <span className="block text-[11px] text-gray-400 dark:text-gray-500 mt-1">
          {hint}
        </span>
      )}
    </label>
  );
}

function splitName(full: string | null): { first: string; last: string } {
  if (!full) return { first: "", last: "" };
  const trimmed = full.trim();
  if (!trimmed) return { first: "", last: "" };
  const idx = trimmed.indexOf(" ");
  if (idx === -1) return { first: trimmed, last: "" };
  return {
    first: trimmed.slice(0, idx),
    last: trimmed.slice(idx + 1).trim(),
  };
}
