"use client";
import { useEffect, useRef, useState } from "react";
import {
  createStageAction,
  updateStageAction,
} from "@/lib/actions/admin-stages";
import type { Funnel, PipelineStageRow } from "@/lib/types/database";
import type { StageActionResult } from "@/lib/types/admin";

interface Props {
  open: boolean;
  funnel: Funnel;
  /** null = crear; row = editar. */
  stage: PipelineStageRow | null;
  onClose: () => void;
  onSaved: (stages: PipelineStageRow[]) => void;
}

/**
 * Modal de creación / edición de etapa (M7.2, Bloque 3).
 *
 * Bloqueos en UI antes de submit (el backend revalida igual):
 *   - is_won + is_lost mutuamente excluyentes (al marcar uno se
 *     deshabilita el otro).
 *   - default_probability solo visible en Funnel Venta.
 */
export function StageFormModal({ open, funnel, stage, onClose, onSaved }: Props) {
  const isEdit = stage !== null;
  const [name, setName] = useState("");
  const [color, setColor] = useState("#94A3B8");
  const [probability, setProbability] = useState<string>("");
  const [isInitial, setIsInitial] = useState(false);
  const [isWon, setIsWon] = useState(false);
  const [isLost, setIsLost] = useState(false);
  const [requiresLoss, setRequiresLoss] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(stage?.name ?? "");
    setColor(stage?.color ?? "#94A3B8");
    setProbability(
      stage?.default_probability != null ? String(stage.default_probability) : "",
    );
    setIsInitial(stage?.is_initial ?? false);
    setIsWon(stage?.is_won ?? false);
    setIsLost(stage?.is_lost ?? false);
    setRequiresLoss(stage?.requires_loss_reason ?? false);
    setError(null);
    setSubmitting(false);
  }, [open, stage]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    const probNum =
      funnel === "venta" && probability.trim() !== ""
        ? Number(probability)
        : null;
    if (probNum !== null && (Number.isNaN(probNum) || probNum < 0 || probNum > 100)) {
      setError("La probabilidad debe estar entre 0 y 100.");
      setSubmitting(false);
      return;
    }

    const base = {
      name: name.trim(),
      color,
      default_probability: probNum,
      is_initial: isInitial,
      is_won: isWon,
      is_lost: isLost,
      requires_loss_reason: requiresLoss,
    };
    const res: StageActionResult = isEdit
      ? await updateStageAction({ id: stage!.id, ...base })
      : await createStageAction({ funnel, ...base });

    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onSaved(res.stages);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="stage-form-title"
      onClick={submitting ? undefined : onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 outline-none"
      >
        <p
          id="stage-form-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          {isEdit ? "Editar etapa" : "Nueva etapa"}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {funnel === "venta" ? "Funnel Venta" : "Funnel Post-venta"}
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Nombre
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              disabled={submitting}
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
            />
          </label>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
                Color
              </span>
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                disabled={submitting}
                className="h-8 w-12 rounded border border-gray-200 dark:border-gray-700 bg-transparent"
              />
            </label>
            {funnel === "venta" && (
              <label className="flex-1">
                <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                  Probabilidad (%)
                </span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={probability}
                  onChange={(e) => setProbability(e.target.value)}
                  disabled={submitting}
                  className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
                />
              </label>
            )}
          </div>

          <fieldset className="space-y-1.5 pt-1">
            <FlagCheckbox
              label="Etapa inicial"
              checked={isInitial}
              onChange={setIsInitial}
              disabled={submitting}
            />
            <FlagCheckbox
              label="Etapa Ganada"
              checked={isWon}
              onChange={(v) => {
                setIsWon(v);
                if (v) setIsLost(false);
              }}
              disabled={submitting || isLost}
            />
            <FlagCheckbox
              label="Etapa Perdida"
              checked={isLost}
              onChange={(v) => {
                setIsLost(v);
                if (v) setIsWon(false);
              }}
              disabled={submitting || isWon}
            />
            <FlagCheckbox
              label="Requiere motivo de pérdida"
              checked={requiresLoss}
              onChange={setRequiresLoss}
              disabled={submitting}
            />
          </fieldset>

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
              onClick={onClose}
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
              {submitting ? "Guardando..." : isEdit ? "Guardar" : "Crear etapa"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function FlagCheckbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500 disabled:opacity-40"
      />
      {label}
    </label>
  );
}
