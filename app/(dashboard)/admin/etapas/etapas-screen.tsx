"use client";
import { useState } from "react";
import {
  deleteStageAction,
  prepareStageDeletionAction,
  reactivateStageAction,
  reorderStagesAction,
} from "@/lib/actions/admin-stages";
import type { Funnel, UUID } from "@/lib/types/database";
import type { StageAdminView, StageDeletionPlan } from "@/lib/types/admin";
import { StageList } from "./stage-list";
import { StageFormModal } from "./stage-form-modal";

interface Props {
  initialVenta: StageAdminView[];
  initialPostVenta: StageAdminView[];
}

interface DeleteFlow {
  stage: StageAdminView;
  loading: boolean;
  plan: StageDeletionPlan | null;
}

/**
 * Pantalla admin de Etapas del pipeline (M7.2, Bloque 3 + fix panel A).
 * Sub-toggle Venta/Post-venta, CRUD + reorder drag-and-drop.
 *
 * Borrado (fix Bloque A): al pedir eliminar, el servidor resuelve el
 * plan (borrar / desactivar / bloqueado). Una etapa con historial
 * inmutable NO se puede borrar en duro (FK `on delete restrict`); se
 * DESACTIVA (archiva) preservando la trazabilidad y el diálogo lo
 * explica. Una etapa ligada a automatizaciones exige teclear "eliminar"
 * para el borrado en duro. Las validaciones se revalidan en backend.
 */
export function EtapasScreen({ initialVenta, initialPostVenta }: Props) {
  const [funnel, setFunnel] = useState<Funnel>("venta");
  const [venta, setVenta] = useState(initialVenta);
  const [postVenta, setPostVenta] = useState(initialPostVenta);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<StageAdminView | null>(null);
  const [deleteFlow, setDeleteFlow] = useState<DeleteFlow | null>(null);

  const stages = funnel === "venta" ? venta : postVenta;
  const applyStages = (next: StageAdminView[]) =>
    funnel === "venta" ? setVenta(next) : setPostVenta(next);

  function openCreate() {
    setEditing(null);
    setModalOpen(true);
  }
  function openEdit(stage: StageAdminView) {
    setEditing(stage);
    setModalOpen(true);
  }

  async function handleReorder(orderedIds: UUID[]) {
    // Optimista: reordenar local de inmediato.
    const map = new Map(stages.map((s) => [s.id, s]));
    const optimistic = orderedIds
      .map((id, i) => {
        const s = map.get(id);
        return s ? { ...s, position: i + 1 } : null;
      })
      .filter((s): s is StageAdminView => s !== null);
    applyStages(optimistic);
    setBusy(true);
    const res = await reorderStagesAction({ funnel, orderedIds });
    setBusy(false);
    if (!res.ok) {
      setBanner({ tone: "error", text: res.message });
      return;
    }
    applyStages(res.stages);
  }

  // Paso 1 del borrado: pedir al servidor el plan (borrar/desactivar/bloqueado).
  async function requestDelete(stage: StageAdminView) {
    setDeleteFlow({ stage, loading: true, plan: null });
    const res = await prepareStageDeletionAction({ id: stage.id });
    if (!res.ok) {
      setDeleteFlow(null);
      setBanner({ tone: "error", text: res.message });
      return;
    }
    setDeleteFlow({ stage, loading: false, plan: res.plan });
  }

  // Paso 2: confirmar. `confirmWord` solo aplica al borrado en duro de una
  // etapa ligada a automatizaciones.
  async function confirmDelete(confirmWord: string) {
    if (!deleteFlow?.plan) return;
    const target = deleteFlow.stage;
    setBusy(true);
    const res = await deleteStageAction({ id: target.id, confirm: confirmWord });
    setBusy(false);
    if (!res.ok) {
      setBanner({ tone: "error", text: res.message });
      // Mantener el diálogo abierto si fue por falta de la palabra.
      return;
    }
    setDeleteFlow(null);
    applyStages(res.stages);
    const text =
      res.outcome === "deactivated"
        ? "Etapa desactivada (archivada). Conserva su historial y ya no aparece en el pipeline."
        : "Etapa eliminada.";
    setBanner({ tone: "success", text });
  }

  async function handleReactivate(stage: StageAdminView) {
    setBusy(true);
    const res = await reactivateStageAction({ id: stage.id });
    setBusy(false);
    if (!res.ok) {
      setBanner({ tone: "error", text: res.message });
      return;
    }
    applyStages(res.stages);
    setBanner({ tone: "success", text: "Etapa reactivada. Vuelve a aparecer en el pipeline." });
  }

  return (
    <div className="max-w-3xl mx-auto">
      <header className="flex items-center justify-between gap-4 mb-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Etapas del pipeline
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Configura las etapas, su orden y comportamiento por funnel.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 whitespace-nowrap"
        >
          + Nueva etapa
        </button>
      </header>

      <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-0.5 mb-4">
        <FunnelTab active={funnel === "venta"} onClick={() => setFunnel("venta")}>
          Funnel Venta
        </FunnelTab>
        <FunnelTab active={funnel === "post_venta"} onClick={() => setFunnel("post_venta")}>
          Funnel Post-venta
        </FunnelTab>
      </div>

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
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="text-xs underline opacity-80 hover:opacity-100"
          >
            cerrar
          </button>
        </div>
      )}

      <StageList
        stages={stages}
        busy={busy}
        onReorder={handleReorder}
        onEdit={openEdit}
        onDelete={requestDelete}
        onReactivate={handleReactivate}
      />

      <StageFormModal
        open={modalOpen}
        funnel={funnel}
        stage={editing}
        onClose={() => setModalOpen(false)}
        onSaved={(next) => {
          applyStages(next);
          setModalOpen(false);
          setBanner({ tone: "success", text: editing ? "Etapa actualizada." : "Etapa creada." });
        }}
      />

      {deleteFlow && (
        <DeleteDialog
          flow={deleteFlow}
          busy={busy}
          onCancel={() => setDeleteFlow(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}

function FunnelTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
        active
          ? "bg-indigo-600 text-white"
          : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Diálogo de eliminación adaptativo (fix Bloque A). Renderiza según el
 * plan resuelto en servidor:
 *   - loading      → spinner mientras el servidor decide.
 *   - "blocked"    → hay oportunidades vivas; mover primero (no borra).
 *   - "deactivate" → tiene historial inmutable; se archiva (desactiva),
 *                    NO se puede borrar en duro. Sin palabra "eliminar".
 *   - "delete"     → borrado real; si la etapa está ligada a
 *                    automatizaciones, exige teclear "eliminar".
 */
function DeleteDialog({
  flow,
  busy,
  onCancel,
  onConfirm,
}: {
  flow: DeleteFlow;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (confirmWord: string) => void;
}) {
  const [word, setWord] = useState("");
  const { stage, loading, plan } = flow;
  const linked = plan?.automation.linked ?? false;
  const needsWord = plan?.action === "delete" && linked;
  const canConfirm = !busy && !loading && plan != null && plan.action !== "blocked" &&
    (!needsWord || word.trim().toLowerCase() === "eliminar");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={busy ? undefined : onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6"
      >
        <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {plan?.action === "deactivate"
            ? "Desactivar etapa"
            : plan?.action === "blocked"
              ? "No se puede eliminar"
              : "Eliminar etapa"}
        </p>

        {loading || !plan ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-3">Comprobando dependencias…</p>
        ) : (
          <div className="mt-2 space-y-3">
            {plan.action === "blocked" && (
              <p className="text-sm text-gray-600 dark:text-gray-300">
                La etapa <span className="font-medium">{stage.name}</span> tiene{" "}
                <span className="font-medium">{plan.opportunityCount}</span> oportunidad
                {plan.opportunityCount === 1 ? "" : "es"} dentro. Muévelas a otra etapa antes de
                eliminarla.
              </p>
            )}

            {plan.action === "deactivate" && (
              <>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  La etapa <span className="font-medium">{stage.name}</span> no se puede eliminar
                  porque <span className="font-medium">tiene historial</span>: oportunidades pasaron
                  por ella y ese registro es permanente (no se borra para conservar la trazabilidad).
                </p>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  En su lugar se <span className="font-medium">desactivará</span>: desaparece del
                  pipeline y deja de ser destino de movimientos, pero su historial se conserva y
                  puedes reactivarla después.
                </p>
              </>
            )}

            {plan.action === "delete" && (
              <p className="text-sm text-gray-600 dark:text-gray-300">
                ¿Eliminar la etapa <span className="font-medium">{stage.name}</span>? No tiene
                oportunidades ni historial. Esta acción no se puede deshacer.
              </p>
            )}

            {/* Advertencia de automatización (deactivate + delete). */}
            {plan.action !== "blocked" && linked && (
              <div className="rounded-md bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 px-3 py-2">
                <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                  ⚠ Hay automatizaciones ligadas a esta etapa. Se romperán:
                </p>
                <ul className="mt-1 list-disc list-inside space-y-0.5">
                  {plan.automation.reasons.map((r, i) => (
                    <li key={i} className="text-xs text-amber-800 dark:text-amber-300">
                      {r}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {needsWord && (
              <label className="block">
                <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                  Escribe <span className="font-mono font-semibold">eliminar</span> para confirmar
                </span>
                <input
                  type="text"
                  value={word}
                  onChange={(e) => setWord(e.target.value)}
                  disabled={busy}
                  autoFocus
                  autoComplete="off"
                  className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
                />
              </label>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            {plan?.action === "blocked" ? "Entendido" : "Cancelar"}
          </button>
          {plan && plan.action !== "blocked" && (
            <button
              type="button"
              onClick={() => onConfirm(word)}
              disabled={!canConfirm}
              className={`px-3 py-1.5 text-sm rounded-md text-white disabled:opacity-50 ${
                plan.action === "deactivate"
                  ? "bg-amber-600 hover:bg-amber-700 disabled:bg-amber-300"
                  : "bg-red-600 hover:bg-red-700 disabled:bg-red-300"
              }`}
            >
              {busy
                ? plan.action === "deactivate"
                  ? "Desactivando…"
                  : "Eliminando…"
                : plan.action === "deactivate"
                  ? "Desactivar"
                  : "Eliminar"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
