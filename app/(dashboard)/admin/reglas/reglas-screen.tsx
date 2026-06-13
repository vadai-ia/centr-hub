"use client";
import { useMemo, useState, useTransition } from "react";
import type {
  AutomationRuleRow,
  Funnel,
  PipelineStageRow,
  RuleTriggerType,
} from "@/lib/types/database";
import {
  describeTrigger,
  describeActionType,
} from "@/lib/automation/rule-config";
import {
  createRuleAction,
  updateRuleAction,
  toggleRuleAction,
  deleteRuleAction,
  type RulesActionResult,
} from "@/lib/actions/admin-rules";
import { RuleFormModal, type RuleFormValue } from "./rule-form-modal";
import { Switch } from "@/components/ui/switch";

interface Props {
  initialRules: AutomationRuleRow[];
  stages: PipelineStageRow[];
}

const FUNNEL_LABEL: Record<Funnel, string> = {
  venta: "Funnel Venta",
  post_venta: "Funnel Post-venta",
};

export function ReglasScreen({ initialRules, stages }: Props) {
  const [rules, setRules] = useState(initialRules);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [editing, setEditing] = useState<AutomationRuleRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [pending, startTransition] = useTransition();

  const grouped = useMemo(() => {
    const venta = rules.filter((r) => r.funnel === "venta");
    const post = rules.filter((r) => r.funnel === "post_venta");
    return { venta, post_venta: post };
  }, [rules]);

  function apply(res: RulesActionResult, okMsg: string) {
    if (res.ok) {
      setRules(res.rules);
      setBanner({ kind: "ok", text: okMsg });
      setEditing(null);
      setCreating(false);
    } else {
      setBanner({ kind: "err", text: res.message });
    }
  }

  function onToggle(rule: AutomationRuleRow) {
    startTransition(async () => {
      apply(
        await toggleRuleAction({ id: rule.id, is_active: !rule.is_active }),
        !rule.is_active ? "Regla activada." : "Regla desactivada.",
      );
    });
  }

  function onDelete(rule: AutomationRuleRow) {
    if (!window.confirm(`¿Eliminar la regla "${rule.name}"? Esta acción no se puede deshacer.`)) {
      return;
    }
    startTransition(async () => {
      apply(await deleteRuleAction({ id: rule.id }), "Regla eliminada.");
    });
  }

  function onSubmit(value: RuleFormValue) {
    startTransition(async () => {
      if (value.id) {
        apply(await updateRuleAction(value), "Regla guardada.");
      } else {
        apply(await createRuleAction(value), "Regla creada.");
      }
    });
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm shadow-indigo-300/50 dark:shadow-indigo-900/40">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </span>
            <h1 className="bg-gradient-to-r from-slate-900 to-slate-600 bg-clip-text text-2xl font-bold text-transparent dark:from-white dark:to-slate-400">
              Reglas de automatización
            </h1>
          </div>
          <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
            Cuando una oportunidad cumple una condición de tiempo, la regla crea
            una tarea y/o avisa al asesor o al admin. No mueven de etapa ni
            reasignan.
          </p>
        </div>
        <button
          onClick={() => {
            setBanner(null);
            setCreating(true);
          }}
          className="shrink-0 rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-indigo-300/40 transition-all hover:shadow-md dark:shadow-indigo-900/40"
        >
          + Nueva regla
        </button>
      </div>

      {banner && (
        <div
          className={[
            "mb-4 rounded-xl px-4 py-3 text-sm font-medium ring-1",
            banner.kind === "ok"
              ? "bg-emerald-50 text-emerald-800 ring-emerald-200/70 dark:bg-emerald-900/30 dark:text-emerald-300 dark:ring-emerald-900/50"
              : "bg-rose-50 text-rose-800 ring-rose-200/70 dark:bg-rose-900/30 dark:text-rose-300 dark:ring-rose-900/50",
          ].join(" ")}
        >
          {banner.text}
        </div>
      )}

      {(["venta", "post_venta"] as Funnel[]).map((funnel) => (
        <section key={funnel} className="mb-8">
          <h2 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            <span className="h-3.5 w-1 rounded-full bg-gradient-to-b from-indigo-400 to-violet-500" />
            {FUNNEL_LABEL[funnel]}
          </h2>
          <div className="space-y-2">
            {grouped[funnel].length === 0 && (
              <p className="text-sm text-gray-400 dark:text-gray-500">
                Sin reglas en este funnel.
              </p>
            )}
            {grouped[funnel].map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                disabled={pending}
                onToggle={() => onToggle(rule)}
                onEdit={() => {
                  setBanner(null);
                  setEditing(rule);
                }}
                onDelete={() => onDelete(rule)}
              />
            ))}
          </div>
        </section>
      ))}

      {(creating || editing) && (
        <RuleFormModal
          rule={editing}
          stages={stages}
          pending={pending}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSubmit={onSubmit}
        />
      )}
    </div>
  );
}

function RuleRow({
  rule,
  disabled,
  onToggle,
  onEdit,
  onDelete,
}: {
  rule: AutomationRuleRow;
  disabled: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const actionTypes = Array.isArray(rule.actions)
    ? (rule.actions as Array<{ type?: string }>).map((a) => a?.type ?? "")
    : [];
  return (
    <div
      className={[
        "flex items-start justify-between gap-4 rounded-2xl border bg-white p-4 shadow-sm transition-all dark:bg-slate-800",
        rule.is_active
          ? "border-slate-200 hover:border-indigo-200 hover:shadow-md dark:border-slate-700 dark:hover:border-indigo-800"
          : "border-slate-200/70 bg-slate-50/60 dark:border-slate-700/60 dark:bg-slate-800/50",
      ].join(" ")}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={[
              "h-2 w-2 shrink-0 rounded-full",
              rule.is_active ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600",
            ].join(" ")}
            title={rule.is_active ? "Activa" : "Inactiva"}
          />
          <span className={`font-semibold ${rule.is_active ? "text-slate-900 dark:text-slate-100" : "text-slate-500 dark:text-slate-400"}`}>
            {rule.name}
          </span>
          {rule.is_template && (
            <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-slate-500 dark:bg-slate-700 dark:text-slate-400">
              Preconfigurada
            </span>
          )}
        </div>
        <p className="mt-1.5 pl-4 text-sm text-slate-600 dark:text-slate-400">
          {describeTrigger(rule.trigger_type as RuleTriggerType, rule.trigger_config)}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5 pl-4">
          {actionTypes.map((t, i) => (
            <span
              key={i}
              className={[
                "rounded-full px-2 py-0.5 text-xs font-medium ring-1",
                t === "notify_admin"
                  ? "bg-amber-50 text-amber-700 ring-amber-200/70 dark:bg-amber-900/20 dark:text-amber-300 dark:ring-amber-900/40"
                  : t === "create_task"
                    ? "bg-emerald-50 text-emerald-700 ring-emerald-200/70 dark:bg-emerald-900/20 dark:text-emerald-300 dark:ring-emerald-900/40"
                    : "bg-indigo-50 text-indigo-700 ring-indigo-200/70 dark:bg-indigo-900/20 dark:text-indigo-300 dark:ring-indigo-900/40",
              ].join(" ")}
            >
              {describeActionType(t)}
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Switch
          checked={rule.is_active}
          onChange={onToggle}
          disabled={disabled}
          ariaLabel={rule.is_active ? "Desactivar regla" : "Activar regla"}
          title={rule.is_active ? "Activa — clic para desactivar" : "Inactiva — clic para activar"}
        />
        <button
          onClick={onEdit}
          disabled={disabled}
          className="text-sm font-medium text-slate-500 hover:text-indigo-600 disabled:opacity-50 dark:text-slate-400"
        >
          Editar
        </button>
        <button
          onClick={onDelete}
          disabled={disabled}
          className="text-sm font-medium text-slate-400 hover:text-rose-600 disabled:opacity-50"
        >
          Eliminar
        </button>
      </div>
    </div>
  );
}
