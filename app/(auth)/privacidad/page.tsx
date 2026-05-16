import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Aviso de privacidad — Centr Hub",
};

export default function PrivacidadPage() {
  return (
    <div className="w-full max-w-2xl space-y-6 py-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          Aviso de privacidad
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Última actualización: mayo 2026
        </p>
      </div>

      <div className="space-y-4 text-sm text-gray-700 dark:text-gray-300">
        <p>
          Centr Hub es una plataforma de gestión de pipeline de ventas operada
          por VADAI. Los datos personales que se recopilan en esta plataforma
          son utilizados exclusivamente para la operación del servicio
          contratado.
        </p>

        <h2 className="text-base font-semibold text-gray-900 dark:text-white">
          Datos recopilados
        </h2>
        <p>
          Se recopilan datos de contacto de clientes (nombre, correo
          electrónico, teléfono), datos de transacciones comerciales y datos de
          acceso de usuarios autorizados de la organización.
        </p>

        <h2 className="text-base font-semibold text-gray-900 dark:text-white">
          Uso de la información
        </h2>
        <p>
          La información se utiliza únicamente para proveer el servicio de
          gestión de pipeline de ventas. No se comparte con terceros no
          autorizados.
        </p>

        <h2 className="text-base font-semibold text-gray-900 dark:text-white">
          Contacto
        </h2>
        <p>
          Para ejercer tus derechos ARCO o para cualquier duda sobre el
          tratamiento de tus datos personales, contacta a tu administrador de
          cuenta o a VADAI directamente.
        </p>
      </div>

      <div className="pt-4">
        <Link
          href="/login"
          className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline underline-offset-2"
        >
          ← Regresar al inicio de sesión
        </Link>
      </div>
    </div>
  );
}
