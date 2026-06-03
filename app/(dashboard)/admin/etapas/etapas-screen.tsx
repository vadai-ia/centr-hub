"use client";
import { useState } from "react";
import {
  deleteStageAction,
  reorderStagesAction,
} from "@/lib/actions/admin-stages";
import type { Funnel, PipelineStageRow, UUID } from "@/lib/types/database";
import { StageList } from "./stage-list";
import { StageFormModal } from "./stage-form-modal";

interface Props {
  initialVenta: PipelineStageRow[];
  initialPostVenta: PipelineStageRow[];
}

/**
 * Pantalla admin de Etapas del pipeline (M7.2, Bloque 3).
 * Sub-toggle Venta/Post-venta, CRUD + reorder drag-and-drop.
 * Las validaciones estructurales se ejecutan en backend; aquí solo
 * se muestran los mensajes de bloqueo.
 */
export function EtapasScreen({ initialVenta, initialPostVenta }: Props) {
  const [funnel, setFunnel] = useState<Funnel>("venta");
  const [venta, setVenta] = useState(initialVenta);
  const [postVenta, setPostVenta] = useState(initialPostVenta);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PipelineStageRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PipelineStageRow | null>(null);

  const stages = funnel === "venta" ? venta : postVenta;
  const applyStages = (next: PipelineStageRow[]) =>
    funnel === "venta" ? setVenta(next) : setPostVenta(next);

  function openCreate() {
    setEditing(null);
    setModalOpen(true);
  }
  function openEdit(stage: PipelineStageRow) {
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
      .filter((s): s is PipelineStageRow => s !== null);
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

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    const res = await deleteStageAction({ id: deleteTarget.id });
    setBusy(false);
    setDeleteTarget(null);
    if (!res.ok) {
      setBanner({ tone: "error", text: res.message });
      return;
    }
    applyStages(res.stages);
    setBanner({ tone: "success", text: "Etapa eliminada." });
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
        onDelete={setDeleteTarget}
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

      {deleteTarget && (
        <ConfirmDelete
          stageName={deleteTarget.name}
          busy={busy}
          onCancel={() => setDeleteTarget(null)}
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

function ConfirmDelete({
  stageName,
  busy,
  onCancel,
  onConfirm,
}: {
  stageName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={busy ? undefined : onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-sm w-full p-6"
      >
        <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Eliminar etapa
        </p>
        <p className="text-sm text-gray-600 dark:text-gray-300 mt-2">
          ¿Eliminar la etapa <span className="font-medium">{stageName}</span>? Esta
          acción no se puede deshacer.
        </p>
        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-md bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300"
          >
            {busy ? "Eliminando..." : "Eliminar"}
          </button>
        </div>
      </div>
    </div>
  );
}
