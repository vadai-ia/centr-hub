"use client";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { PipelineStageRow, UUID } from "@/lib/types/database";

interface Props {
  stages: PipelineStageRow[];
  busy: boolean;
  onReorder: (orderedIds: UUID[]) => void;
  onEdit: (stage: PipelineStageRow) => void;
  onDelete: (stage: PipelineStageRow) => void;
}

/**
 * Lista ordenable de etapas (M7.2, Bloque 3). Reusa @dnd-kit (mismo
 * stack que el kanban M5) con estrategia vertical. El reorder se
 * confirma al soltar; el padre persiste vía `reorderStagesAction`.
 */
export function StageList({ stages, busy, onReorder, onEdit, onDelete }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = stages.findIndex((s) => s.id === active.id);
    const newIndex = stages.findIndex((s) => s.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(stages, oldIndex, newIndex);
    onReorder(next.map((s) => s.id));
  }

  if (stages.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400 py-8 text-center">
        Este funnel no tiene etapas. Agrega la primera con “Nueva etapa”.
      </p>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={stages.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <ul className="space-y-2">
          {stages.map((stage) => (
            <SortableStageRow
              key={stage.id}
              stage={stage}
              busy={busy}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function SortableStageRow({
  stage,
  busy,
  onEdit,
  onDelete,
}: {
  stage: PipelineStageRow;
  busy: boolean;
  onEdit: (s: PipelineStageRow) => void;
  onDelete: (s: PipelineStageRow) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: stage.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5"
    >
      <button
        type="button"
        aria-label="Reordenar"
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 touch-none"
      >
        ⠿
      </button>
      <span
        className="h-4 w-4 rounded-full flex-shrink-0 ring-1 ring-black/5"
        style={{ backgroundColor: stage.color }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
          {stage.name}
        </p>
        <div className="flex flex-wrap gap-1 mt-0.5">
          {stage.is_initial && <FlagBadge>Inicial</FlagBadge>}
          {stage.is_won && <FlagBadge tone="green">Ganada</FlagBadge>}
          {stage.is_lost && <FlagBadge tone="red">Perdida</FlagBadge>}
          {stage.requires_loss_reason && <FlagBadge>Motivo requerido</FlagBadge>}
          {stage.funnel === "venta" && stage.default_probability != null && (
            <FlagBadge>{stage.default_probability}%</FlagBadge>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onEdit(stage)}
        disabled={busy}
        className="px-2 py-1 text-xs rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
      >
        Editar
      </button>
      <button
        type="button"
        onClick={() => onDelete(stage)}
        disabled={busy}
        className="px-2 py-1 text-xs rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
      >
        Eliminar
      </button>
    </li>
  );
}

function FlagBadge({
  children,
  tone = "gray",
}: {
  children: React.ReactNode;
  tone?: "gray" | "green" | "red";
}) {
  const tones = {
    gray: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
    green: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    red: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  } as const;
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}
