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
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            Reglas de automatización
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
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
          className="shrink-0 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          Nueva regla
        </button>
      </div>

      {banner && (
        <div
          className={[
            "mb-4 rounded-md px-4 py-3 text-sm",
            banner.kind === "ok"
              ? "bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-300"
              : "bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300",
          ].join(" ")}
        >
          {banner.text}
        </div>
      )}

      {(["venta", "post_venta"] as Funnel[]).map((funnel) => (
        <section key={funnel} className="mb-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
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
    <div className="flex items-start justify-between gap-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-900 dark:text-gray-100">{rule.name}</span>
          {rule.is_template && (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-gray-500 dark:bg-gray-700 dark:text-gray-400">
              Preconfigurada
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {describeTrigger(rule.trigger_type as RuleTriggerType, rule.trigger_config)}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {actionTypes.map((t, i) => (
            <span
              key={i}
              className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300"
            >
              {describeActionType(t)}
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <button
          onClick={onToggle}
          disabled={disabled}
          aria-pressed={rule.is_active}
          title={rule.is_active ? "Activa — clic para desactivar" : "Inactiva — clic para activar"}
          className={[
            "relative h-6 w-11 rounded-full transition-colors disabled:opacity-50",
            rule.is_active ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600",
          ].join(" ")}
        >
          <span
            className={[
              "absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform",
              rule.is_active ? "translate-x-5" : "translate-x-0.5",
            ].join(" ")}
          />
        </button>
        <button
          onClick={onEdit}
          disabled={disabled}
          className="text-sm text-gray-500 hover:text-indigo-600 disabled:opacity-50 dark:text-gray-400"
        >
          Editar
        </button>
        <button
          onClick={onDelete}
          disabled={disabled}
          className="text-sm text-gray-400 hover:text-red-600 disabled:opacity-50"
        >
          Eliminar
        </button>
      </div>
    </div>
  );
}
