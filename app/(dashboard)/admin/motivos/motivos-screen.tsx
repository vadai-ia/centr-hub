"use client";
import { useState } from "react";
import {
  deleteLossReasonAction,
  updateLossReasonAction,
} from "@/lib/actions/admin-loss-reasons";
import type { LossReasonRow } from "@/lib/types/database";
import { LossReasonFormModal } from "./loss-reason-form-modal";

interface Props {
  initialReasons: LossReasonRow[];
}

/**
 * Pantalla admin de Motivos de pérdida (M7.2, Bloque 4). Lista
 * alfabética, CRUD, desactivar (oculta de futuras pérdidas conservando
 * histórico), eliminación bloqueada si referenciado.
 */
export function MotivosScreen({ initialReasons }: Props) {
  const [reasons, setReasons] = useState(initialReasons);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<LossReasonRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LossReasonRow | null>(null);

  function openCreate() {
    setEditing(null);
    setModalOpen(true);
  }

  async function toggleActive(reason: LossReasonRow) {
    setBusy(true);
    const res = await updateLossReasonAction({
      id: reason.id,
      name: reason.name,
      description: reason.description,
      is_active: !reason.is_active,
    });
    setBusy(false);
    if (!res.ok) {
      setBanner({ tone: "error", text: res.message });
      return;
    }
    setReasons(res.reasons);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    const res = await deleteLossReasonAction({ id: deleteTarget.id });
    setBusy(false);
    setDeleteTarget(null);
    if (!res.ok) {
      setBanner({ tone: "error", text: res.message });
      return;
    }
    setReasons(res.reasons);
    setBanner({ tone: "success", text: "Motivo eliminado." });
  }

  return (
    <div className="max-w-2xl mx-auto">
      <header className="flex items-center justify-between gap-4 mb-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Motivos de pérdida
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Catálogo de razones que el vendedor elige al marcar una oportunidad como perdida.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 whitespace-nowrap"
        >
          + Nuevo motivo
        </button>
      </header>

      {banner && (
        <div
          role={banner.tone === "error" ? "alert" : "status"}
          className={`mb-3 px-3 py-2 rounded-md text-sm flex items-center justify-between gap-3 ${
            banner.tone === "error"
              ? "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300"
              : "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300"
          }`}
        >
          <span>{banner.text}</span>
          <button type="button" onClick={() => setBanner(null)} className="text-xs underline opacity-80 hover:opacity-100">
            cerrar
          </button>
        </div>
      )}

      {reasons.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 py-8 text-center">
          No hay motivos. Agrega el primero con “Nuevo motivo”.
        </p>
      ) : (
        <ul className="space-y-2">
          {reasons.map((reason) => (
            <li
              key={reason.id}
              className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center gap-2">
                  <span className="truncate">{reason.name}</span>
                  {!reason.is_active && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                      Inactivo
                    </span>
                  )}
                </p>
                {reason.description && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                    {reason.description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => toggleActive(reason)}
                disabled={busy}
                className="px-2 py-1 text-xs rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                {reason.is_active ? "Desactivar" : "Activar"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(reason);
                  setModalOpen(true);
                }}
                disabled={busy}
                className="px-2 py-1 text-xs rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                Editar
              </button>
              <button
                type="button"
                onClick={() => setDeleteTarget(reason)}
                disabled={busy}
                className="px-2 py-1 text-xs rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
              >
                Eliminar
              </button>
            </li>
          ))}
        </ul>
      )}

      <LossReasonFormModal
        open={modalOpen}
        reason={editing}
        onClose={() => setModalOpen(false)}
        onSaved={(next) => {
          setReasons(next);
          setModalOpen(false);
          setBanner({ tone: "success", text: editing ? "Motivo actualizado." : "Motivo creado." });
        }}
      />

      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onClick={busy ? undefined : () => setDeleteTarget(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-sm w-full p-6"
          >
            <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">Eliminar motivo</p>
            <p className="text-sm text-gray-600 dark:text-gray-300 mt-2">
              ¿Eliminar <span className="font-medium">{deleteTarget.name}</span>? Si está en uso por
              oportunidades, no se podrá eliminar — desactívalo en su lugar.
            </p>
            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={busy}
                className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={busy}
                className="px-3 py-1.5 text-sm rounded-md bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300"
              >
                {busy ? "Eliminando..." : "Eliminar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
