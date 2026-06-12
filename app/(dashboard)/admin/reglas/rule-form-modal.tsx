"use client";
import { useState } from "react";
import type {
  AutomationRuleRow,
  Funnel,
  PipelineStageRow,
} from "@/lib/types/database";
import { TIME_TRIGGER_TYPES } from "@/lib/automation/rule-config";

export interface RuleFormValue {
  id?: string;
  name: string;
  description: string | null;
  funnel: Funnel;
  trigger_type: (typeof TIME_TRIGGER_TYPES)[number];
  trigger_config: Record<string, unknown>;
  conditions: unknown[];
  actions: Array<Record<string, unknown>>;
}

type TimeTrigger = (typeof TIME_TRIGGER_TYPES)[number];
type Unit = "hours" | "days";

const TRIGGER_LABEL: Record<TimeTrigger, string> = {
  stage_aging: "Tiempo en una etapa",
  no_activity: "Sin actividad en la oportunidad",
  "contact.no_activity": "Sin actividad del contacto",
};

interface Props {
  rule: AutomationRuleRow | null;
  stages: PipelineStageRow[];
  pending: boolean;
  onCancel: () => void;
  onSubmit: (value: RuleFormValue) => void;
}

function deriveThreshold(cfg: Record<string, unknown>): { value: number; unit: Unit } {
  if (typeof cfg.days_in_stage === "number") return { value: cfg.days_in_stage, unit: "days" };
  if (typeof cfg.hours_in_stage === "number") return { value: cfg.hours_in_stage, unit: "hours" };
  if (typeof cfg.days_without_activity === "number")
    return { value: cfg.days_without_activity, unit: "days" };
  if (typeof cfg.hours_without_activity === "number")
    return { value: cfg.hours_without_activity, unit: "hours" };
  return { value: 1, unit: "days" };
}

export function RuleFormModal({ rule, stages, pending, onCancel, onSubmit }: Props) {
  const initialCfg = (rule?.trigger_config ?? {}) as Record<string, unknown>;
  const initialThreshold = deriveThreshold(initialCfg);
  const initialActions = Array.isArray(rule?.actions)
    ? (rule!.actions as Array<{ type?: string; title?: string }>)
    : [];

  const [name, setName] = useState(rule?.name ?? "");
  const [funnel, setFunnel] = useState<Funnel>(rule?.funnel ?? "venta");
  const [triggerType, setTriggerType] = useState<TimeTrigger>(
    (rule?.trigger_type as TimeTrigger) ?? "stage_aging",
  );
  const [stageName, setStageName] = useState<string>(
    (initialCfg.stage_name as string) ?? "",
  );
  const [restrictedStage, setRestrictedStage] = useState<string>(
    (initialCfg.restricted_to_stage as string) ?? "",
  );
  const [excludeTerminal, setExcludeTerminal] = useState<boolean>(
    initialCfg.exclude_terminal_stages === true,
  );
  const [value, setValue] = useState<number>(initialThreshold.value);
  const [unit, setUnit] = useState<Unit>(initialThreshold.unit);

  const [createTask, setCreateTask] = useState(
    initialActions.some((a) => a.type === "create_task"),
  );
  const [taskTitle, setTaskTitle] = useState(
    initialActions.find((a) => a.type === "create_task")?.title ?? "Hacer seguimiento",
  );
  const [notifyAdvisor, setNotifyAdvisor] = useState(
    initialActions.some((a) => a.type === "notify_advisor"),
  );
  const [notifyAdmin, setNotifyAdmin] = useState(
    initialActions.some((a) => a.type === "notify_admin"),
  );
  const [error, setError] = useState<string | null>(null);

  const funnelStages = stages.filter((s) => s.funnel === funnel && s.is_active);

  function buildConfig(): Record<string, unknown> | null {
    if (!Number.isFinite(value) || value <= 0) {
      setError("Define un número de horas o días mayor a cero.");
      return null;
    }
    if (triggerType === "stage_aging") {
      if (!stageName) {
        setError("Elige una etapa.");
        return null;
      }
      return {
        stage_name: stageName,
        [unit === "days" ? "days_in_stage" : "hours_in_stage"]: value,
      };
    }
    if (triggerType === "no_activity") {
      const cfg: Record<string, unknown> = {
        [unit === "days" ? "days_without_activity" : "hours_without_activity"]: value,
        exclude_terminal_stages: excludeTerminal,
      };
      if (restrictedStage) cfg.restricted_to_stage = restrictedStage;
      return cfg;
    }
    return {
      [unit === "days" ? "days_without_activity" : "hours_without_activity"]: value,
    };
  }

  function submit() {
    setError(null);
    if (!name.trim()) {
      setError("Ponle un nombre a la regla.");
      return;
    }
    const cfg = buildConfig();
    if (!cfg) return;
    const actions: Array<Record<string, unknown>> = [];
    if (createTask)
      actions.push({ type: "create_task", task_type: "follow_up", title: taskTitle.trim() || "Hacer seguimiento" });
    if (notifyAdvisor) actions.push({ type: "notify_advisor" });
    if (notifyAdmin) actions.push({ type: "notify_admin" });
    if (actions.length === 0) {
      setError("Elige al menos una acción (crear tarea y/o avisar).");
      return;
    }
    onSubmit({
      id: rule?.id,
      name: name.trim(),
      description: null,
      funnel,
      trigger_type: triggerType,
      trigger_config: cfg,
      conditions: Array.isArray(rule?.conditions) ? (rule!.conditions as unknown[]) : [],
      actions,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
          {rule ? "Editar regla" : "Nueva regla"}
        </h2>

        <div className="space-y-4">
          <Field label="Nombre">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
              placeholder="Ej. Cotización sin respuesta 24h"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Funnel">
              <select
                value={funnel}
                onChange={(e) => {
                  setFunnel(e.target.value as Funnel);
                  setStageName("");
                  setRestrictedStage("");
                }}
                className={inputCls}
              >
                <option value="venta">Venta</option>
                <option value="post_venta">Post-venta</option>
              </select>
            </Field>
            <Field label="Disparador">
              <select
                value={triggerType}
                onChange={(e) => setTriggerType(e.target.value as TimeTrigger)}
                className={inputCls}
              >
                {TIME_TRIGGER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TRIGGER_LABEL[t]}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {triggerType === "stage_aging" && (
            <Field label="Etapa">
              <select value={stageName} onChange={(e) => setStageName(e.target.value)} className={inputCls}>
                <option value="">Elige una etapa…</option>
                {funnelStages.map((s) => (
                  <option key={s.id} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label={triggerType === "stage_aging" ? "Tiempo en etapa" : "Tiempo sin actividad"}>
              <input
                type="number"
                min={1}
                value={value}
                onChange={(e) => setValue(parseInt(e.target.value, 10))}
                className={inputCls}
              />
            </Field>
            <Field label="Unidad">
              <select value={unit} onChange={(e) => setUnit(e.target.value as Unit)} className={inputCls}>
                <option value="hours">Horas</option>
                <option value="days">Días</option>
              </select>
            </Field>
          </div>

          {triggerType === "no_activity" && (
            <>
              <Field label="Restringir a una etapa (opcional)">
                <select
                  value={restrictedStage}
                  onChange={(e) => setRestrictedStage(e.target.value)}
                  className={inputCls}
                >
                  <option value="">Cualquier etapa</option>
                  {funnelStages.map((s) => (
                    <option key={s.id} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={excludeTerminal}
                  onChange={(e) => setExcludeTerminal(e.target.checked)}
                />
                Excluir oportunidades ganadas/perdidas
              </label>
            </>
          )}

          <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Acciones</p>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={createTask} onChange={(e) => setCreateTask(e.target.checked)} />
              Crear tarea
            </label>
            {createTask && (
              <input
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="Título de la tarea"
                className={`${inputCls} mt-2`}
              />
            )}
            <label className="mt-2 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={notifyAdvisor} onChange={(e) => setNotifyAdvisor(e.target.checked)} />
              Avisar al asesor
            </label>
            <label className="mt-2 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={notifyAdmin} onChange={(e) => setNotifyAdmin(e.target.checked)} />
              Avisar al admin
            </label>
          </div>

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={pending}
            className="rounded-md px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={pending}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {rule ? "Guardar" : "Crear"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{label}</span>
      {children}
    </label>
  );
}
