/**
 * Aterrizaje defensivo (0039) para un rol sin ninguna pestaña asignada —
 * estado que el constructor de roles IMPIDE guardar (un rol siempre lleva al
 * menos una pestaña) y que los roles de sistema nunca tienen. Existe solo para
 * que `landingHref`/`requireTabOrRedirect` nunca redirijan a una ruta 404.
 */
export default function NoAccessPage() {
  return (
    <div className="max-w-sm mx-auto py-24 text-center space-y-2">
      <p className="text-sm text-gray-700 dark:text-gray-300">
        Tu rol no tiene ninguna pestaña habilitada.
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Pide a un administrador que ajuste tu rol en Roles y permisos.
      </p>
    </div>
  );
}
