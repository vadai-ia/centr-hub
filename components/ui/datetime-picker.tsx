"use client";
import { useEffect, useRef, useState } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";

interface Props {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * Selector de fecha y hora moderno con react-day-picker (lote polish M6).
 *
 * Acepta y emite un ISO string completo (UTC). UI muestra y captura
 * en zona horaria local del navegador, igual que el `datetime-local`
 * nativo. Reemplazo visual coherente con el resto del sistema (Centr).
 */
export function DateTimePicker({ value, onChange, disabled, placeholder = "Sin fecha" }: Props) {
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState("09");
  const [minutes, setMinutes] = useState("00");
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (value) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) {
        setSelectedDate(d);
        setHours(String(d.getHours()).padStart(2, "0"));
        setMinutes(String(d.getMinutes()).padStart(2, "0"));
      }
    } else {
      setSelectedDate(undefined);
      setHours("09");
      setMinutes("00");
    }
  }, [value]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function handleSelect(date: Date | undefined) {
    if (!date) return;
    const merged = new Date(date);
    const h = Math.min(23, Math.max(0, parseInt(hours, 10) || 0));
    const m = Math.min(59, Math.max(0, parseInt(minutes, 10) || 0));
    merged.setHours(h, m, 0, 0);
    setSelectedDate(merged);
    onChange(merged.toISOString());
  }

  function handleTimeChange(nextHours: string, nextMinutes: string) {
    setHours(nextHours);
    setMinutes(nextMinutes);
    if (selectedDate) {
      const h = Math.min(23, Math.max(0, parseInt(nextHours, 10) || 0));
      const m = Math.min(59, Math.max(0, parseInt(nextMinutes, 10) || 0));
      const merged = new Date(selectedDate);
      merged.setHours(h, m, 0, 0);
      setSelectedDate(merged);
      onChange(merged.toISOString());
    }
  }

  function clear() {
    setSelectedDate(undefined);
    onChange(null);
    setOpen(false);
  }

  const label = selectedDate
    ? formatHumanDate(selectedDate)
    : placeholder;

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={[
          "w-full flex items-center justify-between gap-2 px-3 py-2 text-sm rounded-md",
          "bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600",
          "text-gray-900 dark:text-gray-100",
          "focus:outline-none focus:ring-2 focus:ring-amber-400",
          "disabled:opacity-50 disabled:cursor-not-allowed hover:border-gray-300 dark:hover:border-gray-500 transition-colors",
        ].join(" ")}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 min-w-0">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 flex-shrink-0">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/>
            <line x1="8" y1="2" x2="8" y2="6"/>
            <line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          <span className={selectedDate ? "" : "text-gray-400 dark:text-gray-500"}>
            {label}
          </span>
        </span>
        {selectedDate && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              clear();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                clear();
              }
            }}
            className="text-gray-400 hover:text-rose-500 transition-colors"
            aria-label="Quitar fecha"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </span>
        )}
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute z-[80] mt-2 left-0 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 p-3"
          role="dialog"
          aria-label="Selector de fecha y hora"
        >
          <DayPicker
            mode="single"
            selected={selectedDate}
            onSelect={handleSelect}
            classNames={{
              root: "text-sm",
              month_caption: "flex items-center justify-between mb-2",
              caption_label: "text-sm font-semibold text-gray-900 dark:text-gray-100",
              nav: "flex gap-1",
              button_previous: "p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300",
              button_next: "p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300",
              chevron: "w-4 h-4",
              month_grid: "border-collapse",
              weekdays: "text-[10px] uppercase text-gray-400 dark:text-gray-500",
              weekday: "px-1 py-1 font-normal text-center w-8",
              day: "w-8 h-8 text-center align-middle",
              day_button: "w-8 h-8 rounded-md text-sm hover:bg-amber-50 dark:hover:bg-amber-500/15 hover:text-amber-700 dark:hover:text-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-400 transition-colors",
              selected: "[&_button]:bg-amber-400 [&_button]:text-gray-900 [&_button]:font-semibold",
              today: "[&_button]:ring-1 [&_button]:ring-amber-300 [&_button]:font-semibold",
              outside: "text-gray-300 dark:text-gray-600",
              disabled: "opacity-40 cursor-not-allowed",
            }}
          />
          <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 text-sm">
              <span className="text-xs text-gray-500 dark:text-gray-400">Hora</span>
              <input
                type="number"
                min={0}
                max={23}
                value={hours}
                onChange={(e) => handleTimeChange(e.target.value.padStart(2, "0").slice(0, 2), minutes)}
                className="w-12 px-2 py-1 rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-center tabular-nums focus:outline-none focus:ring-2 focus:ring-amber-400"
                aria-label="Hora"
              />
              <span className="font-semibold">:</span>
              <input
                type="number"
                min={0}
                max={59}
                value={minutes}
                onChange={(e) => handleTimeChange(hours, e.target.value.padStart(2, "0").slice(0, 2))}
                className="w-12 px-2 py-1 rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-center tabular-nums focus:outline-none focus:ring-2 focus:ring-amber-400"
                aria-label="Minutos"
              />
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs px-2.5 py-1 rounded-md bg-gray-900 text-white hover:bg-black dark:bg-amber-400 dark:text-gray-900 dark:hover:bg-amber-300"
            >
              Listo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatHumanDate(d: Date): string {
  const date = d.toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
  const time = d.toLocaleTimeString("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${date} · ${time}`;
}
