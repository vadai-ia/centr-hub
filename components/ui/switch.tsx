"use client";

/**
 * Switch (toggle) accesible y a prueba de deformación.
 *
 * Patrón flex + `border-2 border-transparent`: el riel (`h-6 w-11`) con
 * borde transparente de 2px deja una caja de contenido de 40×20px; el
 * pulgar (`h-5 w-5` = 20px) encaja EXACTO en alto y viaja de 0 a 20px sin
 * salirse jamás del riel. Reemplaza al toggle anterior posicionado con
 * `absolute`, que se veía rectangular / con el círculo fuera del riel.
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
  title,
  ariaLabel,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={onChange}
      className={[
        "relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer items-center rounded-full",
        "border-2 border-transparent transition-colors duration-200 ease-in-out",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked
          ? "bg-emerald-500 shadow-inner shadow-emerald-700/20"
          : "bg-slate-300 dark:bg-slate-600",
      ].join(" ")}
    >
      <span
        aria-hidden
        className={[
          "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0",
          "transition-transform duration-200 ease-in-out",
          checked ? "translate-x-5" : "translate-x-0",
        ].join(" ")}
      />
    </button>
  );
}
