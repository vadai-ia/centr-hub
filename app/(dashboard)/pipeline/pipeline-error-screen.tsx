interface Props {
  reason: string;
}

/**
 * Pantalla de error del pipeline cuando `loadInitialPipelineState`
 * no devuelve datos (sin sesión, sin membership, error interno).
 * El layout ya muestra Navbar + Sidebar, así que este componente
 * solo cubre el área central.
 */
export function PipelineErrorScreen({ reason }: Props) {
  const message =
    reason === "no_membership"
      ? "No tienes acceso a esta organización. Contacta al administrador."
      : reason === "no_session"
        ? "Tu sesión expiró. Vuelve a iniciar sesión."
        : "No se pudo cargar el pipeline. Recarga la página e intenta de nuevo.";

  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p className="text-lg font-medium text-gray-700 dark:text-gray-200">
        Pipeline no disponible
      </p>
      <p className="mt-2 text-sm text-gray-500 dark:text-gray-400 max-w-md">
        {message}
      </p>
    </div>
  );
}
