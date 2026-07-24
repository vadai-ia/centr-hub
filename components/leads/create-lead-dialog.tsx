"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  loadLeadFormData,
  createManualLeadAction,
  createOutboundLeadAction,
  type LeadAdvisorOption,
} from "@/lib/actions/leads";

/**
 * Botón + modal de creación manual de lead (0038, Bloque A). Disponible a
 * cualquier usuario autenticado. Nombre y teléfono obligatorios; email y
 * dirección opcionales; se elige el asesor. Reusa `createManualLeadAction`
 * (camino canónico). Se puede montar en cualquier header (Contactos).
 *
 * `outbound` (Fase 2): variante para el pipeline Outbound (solo admin/SDR).
 * Sin selección de asesor (el SDR no es asignable — se elige en el handoff);
 * marca el contacto como outbound y lo crea en el funnel Outbound. Dedup por
 * identidad: si el contacto ya existía (inbound), lo enlaza y lo convierte.
 */
export function CreateLeadButton({ outbound = false }: { outbound?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [advisors, setAdvisors] = useState<LeadAdvisorOption[]>([]);
  const [loadingAdvisors, setLoadingAdvisors] = useState(false);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [advisorId, setAdvisorId] = useState("");
  const [showAddress, setShowAddress] = useState(false);
  const [addr, setAddr] = useState({ address1: "", city: "", province: "", zip: "", country: "" });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!open || outbound) return; // Outbound no elige asesor.
    setLoadingAdvisors(true);
    loadLeadFormData().then((res) => {
      setLoadingAdvisors(false);
      if (res.ok) {
        setAdvisors(res.advisors);
        setAdvisorId((prev) => prev || res.selfMembershipId || "");
      }
    });
  }, [open]);

  function reset() {
    setName("");
    setPhone("");
    setEmail("");
    setAdvisorId("");
    setShowAddress(false);
    setAddr({ address1: "", city: "", province: "", zip: "", country: "" });
    setError(null);
    setSuccess(null);
    setSubmitting(false);
  }

  function close() {
    if (submitting) return;
    setOpen(false);
    reset();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    const address =
      showAddress && Object.values(addr).some((v) => v.trim())
        ? {
            address1: addr.address1.trim() || undefined,
            city: addr.city.trim() || undefined,
            province: addr.province.trim() || undefined,
            zip: addr.zip.trim() || undefined,
            country: addr.country.trim() || undefined,
          }
        : null;
    const res = outbound
      ? await createOutboundLeadAction({
          name: name.trim(),
          phone: phone.trim(),
          email: email.trim() || null,
          address,
        })
      : await createManualLeadAction({
          name: name.trim(),
          phone: phone.trim(),
          email: email.trim() || null,
          advisorId: advisorId || null,
          address,
        });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setSuccess(res.message);
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 whitespace-nowrap"
      >
        + Nuevo lead
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-lead-title"
          onClick={close}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 max-h-[90vh] overflow-y-auto"
          >
            <p id="create-lead-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {outbound ? "Nuevo lead — Outbound" : "Nuevo lead"}
            </p>

            {success ? (
              <div className="mt-4">
                <div role="status" className="px-3 py-2 rounded-md bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300 text-sm">
                  {success}
                </div>
                <div className="flex justify-end gap-2 mt-5">
                  <button
                    type="button"
                    onClick={reset}
                    className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                  >
                    Crear otro
                  </button>
                  <button
                    type="button"
                    onClick={close}
                    className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700"
                  >
                    Cerrar
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="mt-4 space-y-3">
                <label className="block">
                  <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Nombre *</span>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={200}
                    required
                    autoFocus
                    disabled={submitting}
                    className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
                  />
                </label>

                <label className="block">
                  <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Teléfono *</span>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    maxLength={40}
                    required
                    placeholder="Ej. 55 1234 5678"
                    disabled={submitting}
                    className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
                  />
                </label>

                <label className="block">
                  <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Email (opcional)</span>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    maxLength={200}
                    disabled={submitting}
                    className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
                  />
                </label>

                {!outbound && (
                  <label className="block">
                    <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Asesor</span>
                    <select
                      value={advisorId}
                      onChange={(e) => setAdvisorId(e.target.value)}
                      disabled={submitting || loadingAdvisors}
                      className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
                    >
                      <option value="">
                        {loadingAdvisors ? "Cargando..." : advisors.length ? "Sin asignar" : "No hay vendedores"}
                      </option>
                      {advisors.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {!showAddress ? (
                  <button
                    type="button"
                    onClick={() => setShowAddress(true)}
                    disabled={submitting}
                    className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                  >
                    + Agregar dirección (opcional)
                  </button>
                ) : (
                  <div className="space-y-2 rounded-md border border-gray-100 dark:border-gray-700 p-3">
                    <input
                      type="text"
                      value={addr.address1}
                      onChange={(e) => setAddr({ ...addr, address1: e.target.value })}
                      placeholder="Calle y número"
                      maxLength={200}
                      disabled={submitting}
                      className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="text"
                        value={addr.city}
                        onChange={(e) => setAddr({ ...addr, city: e.target.value })}
                        placeholder="Ciudad"
                        maxLength={200}
                        disabled={submitting}
                        className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
                      />
                      <input
                        type="text"
                        value={addr.province}
                        onChange={(e) => setAddr({ ...addr, province: e.target.value })}
                        placeholder="Estado"
                        maxLength={200}
                        disabled={submitting}
                        className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
                      />
                      <input
                        type="text"
                        value={addr.zip}
                        onChange={(e) => setAddr({ ...addr, zip: e.target.value })}
                        placeholder="CP"
                        maxLength={200}
                        disabled={submitting}
                        className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
                      />
                      <input
                        type="text"
                        value={addr.country}
                        onChange={(e) => setAddr({ ...addr, country: e.target.value })}
                        placeholder="País"
                        maxLength={200}
                        disabled={submitting}
                        className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
                      />
                    </div>
                  </div>
                )}

                {error && (
                  <div role="alert" className="px-3 py-2 rounded-md bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300 text-sm">
                    {error}
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={close}
                    disabled={submitting}
                    className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300"
                  >
                    {submitting ? "Creando..." : "Crear lead"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
