import { redirect } from "next/navigation";

// V2 — pospuesto. Oculto de la navegación en V1 (M7.2, Bloque 1).
// El acceso por URL directa redirige limpio al pipeline para evitar
// que el usuario aterrice en una pantalla vacía o rota.
export default function MiDiaPage() {
  redirect("/pipeline");
}
