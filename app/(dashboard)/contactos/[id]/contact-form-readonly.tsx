import type { ContactRow } from "@/lib/types/database";
import { formatAddress } from "../utils";

interface Props {
  contact: ContactRow;
}

/**
 * Vista de solo lectura de los campos del contacto (M6 — B3).
 *
 * En B3 esta vista es read-only. B8 la reemplaza con un form
 * editable. La elección de mostrar la información como lista
 * descriptiva (no como inputs disabled) hace que el visual sea
 * más legible y deja claro que no es interactivo todavía.
 */
export function ContactFormReadonly({ contact }: Props) {
  const address = formatAddress(contact.address);
  return (
    <section className="bg-white dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700">
      <header className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
          Información del contacto
        </h2>
      </header>
      <dl className="px-4 py-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <Field label="Nombre" value={contact.full_name} />
        <Field label="Email" value={contact.email} />
        <Field label="Teléfono" value={contact.phone} muted={contact.missing_phone} />
        <Field label="Dirección" value={address} fullWidth />
        <Field label="Nota interna" value={contact.internal_note} fullWidth />
      </dl>
    </section>
  );
}

function Field({
  label,
  value,
  fullWidth,
  muted,
}: {
  label: string;
  value: string | null;
  fullWidth?: boolean;
  muted?: boolean;
}) {
  return (
    <div className={fullWidth ? "sm:col-span-2" : ""}>
      <dt className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </dt>
      <dd
        className={[
          "mt-0.5 text-sm",
          muted
            ? "text-amber-700 dark:text-amber-300 italic"
            : value
              ? "text-gray-900 dark:text-gray-100"
              : "text-gray-400 dark:text-gray-500 italic",
        ].join(" ")}
      >
        {value ?? "—"}
      </dd>
    </div>
  );
}

