"use client";
import type { StructuredAddress } from "@/lib/contacts/address";

interface Props {
  value: StructuredAddress;
  onChange: (next: StructuredAddress) => void;
  disabled?: boolean;
  /** id base para los labels/inputs (evita colisiones entre form y modal). */
  idPrefix?: string;
}

/**
 * Campos de dirección estructurada del contacto (Fix de pipeline P2).
 *
 * Los 10 campos replican el formulario de dirección de Shopify y se
 * mapean 1:1 a las claves del Shopify Address. Ninguno es obligatorio.
 * Compartido entre el form de edición de contacto y el modal "Crear
 * contacto en Shopify" para no duplicar el layout.
 */
export function StructuredAddressFields({
  value,
  onChange,
  disabled,
  idPrefix = "addr",
}: Props) {
  function set<K extends keyof StructuredAddress>(key: K, v: string) {
    onChange({ ...value, [key]: v });
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-2.5">
      <Field label="País o región" id={`${idPrefix}-country`}>
        <input
          id={`${idPrefix}-country`}
          type="text"
          value={value.country}
          onChange={(e) => set("country", e.target.value)}
          disabled={disabled}
          maxLength={200}
          className={inputClass}
        />
      </Field>
      <Field label="Empresa" id={`${idPrefix}-company`}>
        <input
          id={`${idPrefix}-company`}
          type="text"
          value={value.company}
          onChange={(e) => set("company", e.target.value)}
          disabled={disabled}
          maxLength={200}
          className={inputClass}
        />
      </Field>
      <Field label="Nombre" id={`${idPrefix}-first_name`}>
        <input
          id={`${idPrefix}-first_name`}
          type="text"
          value={value.first_name}
          onChange={(e) => set("first_name", e.target.value)}
          disabled={disabled}
          maxLength={200}
          className={inputClass}
        />
      </Field>
      <Field label="Apellido" id={`${idPrefix}-last_name`}>
        <input
          id={`${idPrefix}-last_name`}
          type="text"
          value={value.last_name}
          onChange={(e) => set("last_name", e.target.value)}
          disabled={disabled}
          maxLength={200}
          className={inputClass}
        />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Calle y número de casa" id={`${idPrefix}-address1`}>
          <input
            id={`${idPrefix}-address1`}
            type="text"
            value={value.address1}
            onChange={(e) => set("address1", e.target.value)}
            disabled={disabled}
            maxLength={200}
            className={inputClass}
          />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Apartamento, interior, etc." id={`${idPrefix}-address2`}>
          <input
            id={`${idPrefix}-address2`}
            type="text"
            value={value.address2}
            onChange={(e) => set("address2", e.target.value)}
            disabled={disabled}
            maxLength={200}
            className={inputClass}
          />
        </Field>
      </div>
      <Field label="Código postal" id={`${idPrefix}-zip`}>
        <input
          id={`${idPrefix}-zip`}
          type="text"
          value={value.zip}
          onChange={(e) => set("zip", e.target.value)}
          disabled={disabled}
          maxLength={200}
          className={inputClass}
        />
      </Field>
      <Field label="Ciudad" id={`${idPrefix}-city`}>
        <input
          id={`${idPrefix}-city`}
          type="text"
          value={value.city}
          onChange={(e) => set("city", e.target.value)}
          disabled={disabled}
          maxLength={200}
          className={inputClass}
        />
      </Field>
      <Field label="Estado" id={`${idPrefix}-province`}>
        <input
          id={`${idPrefix}-province`}
          type="text"
          value={value.province}
          onChange={(e) => set("province", e.target.value)}
          disabled={disabled}
          maxLength={200}
          className={inputClass}
        />
      </Field>
      <Field label="Teléfono (con código de país)" id={`${idPrefix}-phone`}>
        <input
          id={`${idPrefix}-phone`}
          type="tel"
          value={value.phone}
          onChange={(e) => set("phone", e.target.value)}
          disabled={disabled}
          maxLength={200}
          placeholder="+52 55 1234 5678"
          className={inputClass}
        />
      </Field>
    </div>
  );
}

const inputClass =
  "w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50";

function Field({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={id} className="block">
      <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
