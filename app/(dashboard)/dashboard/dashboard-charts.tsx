"use client";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatAmount } from "@/lib/format/money";
import { formatCount } from "@/lib/format/dashboard";
import type { LossByReason, MonthValue } from "@/lib/types/dashboard";

/**
 * Gráficas del Dashboard (recharts, client-only). Diseño sobrio: pocas
 * gráficas con propósito, colores consistentes con las tarjetas KPI
 * (verde revenue/ganadas, rojo pérdidas, índigo neutro). Responsive vía
 * ResponsiveContainer; el contenedor padre define la altura.
 */

const AXIS_COLOR = "#9CA3AF";
const GRID_COLOR = "rgba(148,163,184,0.18)";

function ChartFrame({ title, children, empty }: { title: string; children: React.ReactNode; empty: boolean }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm">
      <p className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-3">{title}</p>
      {empty ? (
        <div className="h-56 flex items-center justify-center text-sm text-gray-400 dark:text-gray-500">
          Sin datos en el periodo
        </div>
      ) : (
        <div className="h-56">{children}</div>
      )}
    </div>
  );
}

const tooltipStyle = {
  borderRadius: 8,
  border: "1px solid rgba(148,163,184,0.3)",
  background: "rgba(17,24,39,0.92)",
  color: "#F9FAFB",
  fontSize: 12,
};

export function RevenueByMonthChart({ data, currency }: { data: MonthValue[]; currency: string }) {
  return (
    <ChartFrame title="Revenue por mes" empty={data.length === 0}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_COLOR }} tickLine={false} axisLine={false} />
          <YAxis
            tick={{ fontSize: 11, fill: AXIS_COLOR }}
            tickLine={false}
            axisLine={false}
            width={70}
            tickFormatter={(v: number) => formatAmount(v, currency) ?? String(v)}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            cursor={{ fill: "rgba(148,163,184,0.12)" }}
            formatter={(v) => [formatAmount(Number(v), currency) ?? String(v), "Revenue"]}
          />
          <Bar dataKey="value" fill="#10B981" radius={[4, 4, 0, 0]} maxBarSize={48} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function OrdersByMonthChart({ data }: { data: MonthValue[] }) {
  return (
    <ChartFrame title="Pedidos por mes" empty={data.length === 0}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_COLOR }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 11, fill: AXIS_COLOR }} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
          <Tooltip
            contentStyle={tooltipStyle}
            cursor={{ fill: "rgba(148,163,184,0.12)" }}
            formatter={(v) => [formatCount(Number(v)), "Pedidos"]}
          />
          <Bar dataKey="value" fill="#6366F1" radius={[4, 4, 0, 0]} maxBarSize={48} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function WonVsLostChart({ won, lost }: { won: number; lost: number }) {
  const data = [
    { name: "Ganadas", value: won, fill: "#10B981" },
    { name: "Perdidas", value: lost, fill: "#F43F5E" },
  ];
  return (
    <ChartFrame title="Ganadas vs Perdidas" empty={won === 0 && lost === 0}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 12, fill: AXIS_COLOR }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 11, fill: AXIS_COLOR }} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
          <Tooltip
            contentStyle={tooltipStyle}
            cursor={{ fill: "rgba(148,163,184,0.12)" }}
            formatter={(v) => [formatCount(Number(v)), "Oportunidades"]}
          />
          <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={80}>
            {data.map((d) => (
              <Cell key={d.name} fill={d.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function LossesByReasonChart({ data, currency }: { data: LossByReason[]; currency: string }) {
  const rows = data.map((d) => ({ name: d.reasonName, value: d.count, amount: d.amount }));
  return (
    <ChartFrame title="Pérdidas por motivo" empty={rows.length === 0}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 11, fill: AXIS_COLOR }} tickLine={false} axisLine={false} allowDecimals={false} />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fontSize: 11, fill: AXIS_COLOR }}
            tickLine={false}
            axisLine={false}
            width={120}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            cursor={{ fill: "rgba(148,163,184,0.12)" }}
            formatter={(v, _n, item) => {
              const amount = (item as { payload?: { amount?: number } })?.payload?.amount ?? 0;
              return [`${formatCount(Number(v))} · ${formatAmount(amount, currency) ?? ""}`, "Pérdidas"];
            }}
          />
          <Bar dataKey="value" fill="#F43F5E" radius={[0, 4, 4, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
