/**
 * Traduce un fallo técnico a algo que una persona entienda — módulo PURO.
 *
 * El aviso decía literalmente `{"code":"23505","details":"Key
 * (organization_id, whaapy_contact_id)=(…) already exists."}`. Quien lo lee
 * no es quien lo va a arreglar: no le dice qué pasó, ni si tiene que hacer
 * algo, ni a quién avisar. Un aviso así solo enseña a cerrar avisos.
 *
 * El detalle técnico NO se pierde: sigue entero en `audit_log` y en
 * `origin_reference`, que es donde se diagnostica. Lo que cambia es lo que
 * se PINTA.
 *
 * Tres reglas al escribir una traducción:
 *   - Decir qué dejó de pasar, no qué función falló.
 *   - Decir si hay algo que hacer, y quién. Si no lo puede resolver quien
 *     lee, decirlo — "no se pierde nada, lo revisamos nosotros" es
 *     información, "Revisar logs Inngest" no.
 *   - Nada de códigos, nombres de tabla, de función ni de columna.
 */

export interface SystemFailureInput {
  /** Id de la función de Inngest que falló. */
  functionId: string;
  /** Mensaje crudo del error. */
  errorMessage: string;
}

export interface SystemFailureCopy {
  title: string;
  message: string;
}

/** Qué sistema externo hay detrás de cada función, para nombrarlo. */
function sistemaDe(functionId: string): string | null {
  if (functionId.includes("whaapy")) return "WhatsApp";
  if (functionId.includes("shopify")) return "Shopify";
  return null;
}

/** Qué se estaba haciendo, en términos del negocio. */
function tareaDe(functionId: string): string {
  if (functionId.includes("contact")) return "sincronizar un contacto";
  if (functionId.includes("customer")) return "sincronizar un cliente";
  if (functionId.includes("order")) return "sincronizar un pedido";
  if (functionId.includes("conversation")) return "registrar una conversación";
  if (functionId.includes("delivery") || functionId.includes("message")) {
    return "enviar un mensaje";
  }
  return "sincronizar información";
}

export function describeSystemFailure(input: SystemFailureInput): SystemFailureCopy {
  const err = input.errorMessage ?? "";
  const sistema = sistemaDe(input.functionId);
  const tarea = tareaDe(input.functionId);
  const con = sistema ? ` con ${sistema}` : "";

  // Falta la credencial: ESTO sí lo resuelve quien lee, y en un sitio
  // concreto de la plataforma.
  if (err.includes("vault_missing_credential")) {
    return {
      title: `Falta conectar ${sistema ?? "un sistema"}`,
      message:
        `No se pudo ${tarea}${con} porque esta tienda todavía no tiene esa ` +
        `conexión configurada. Se activa en Administración → Integraciones.`,
    };
  }

  // Pedido sin cliente en Shopify. Es una situación REAL del negocio, no una
  // avería: alguien creó el pedido sin asignarle cliente. Y la resuelve
  // justamente quien lee el aviso.
  if (err.includes("sin customer asociado")) {
    const folio = err.match(/order (\d+)/)?.[1];
    return {
      title: "Un pedido no tiene cliente",
      message:
        `El pedido ${folio ? `#${folio} ` : ""}de Shopify no tiene un cliente ` +
        `asignado, así que no se pudo registrar ni atribuir a nadie. Ábrelo en ` +
        `Shopify y asígnale el cliente: entra solo en cuanto lo tenga.`,
    };
  }

  // Duplicado: el dato ya existía. No se perdió nada y no hay nada que hacer.
  if (err.includes("23505") || err.includes("duplicate key")) {
    return {
      title: "Un dato ya existía",
      message:
        `Al ${tarea}${con} resultó que ese registro ya estaba en la ` +
        `plataforma, así que no se duplicó. No se perdió información y no ` +
        `hay nada que hacer.`,
    };
  }

  // Permisos / token: no lo arregla quien lee, pero sí tiene que avisar.
  if (
    err.includes("401") ||
    err.includes("403") ||
    err.toLowerCase().includes("unauthorized") ||
    err.toLowerCase().includes("forbidden")
  ) {
    return {
      title: `Se perdió el acceso a ${sistema ?? "un sistema"}`,
      message:
        `La plataforma dejó de tener permiso para ${tarea}${con}. Hay que ` +
        `renovar la conexión desde Administración → Integraciones.`,
    };
  }

  // Límite de peticiones o caída temporal: se reintenta solo.
  if (
    err.includes("429") ||
    err.includes("rate limit") ||
    err.includes("ETIMEDOUT") ||
    err.includes("ECONNRESET") ||
    err.includes("503")
  ) {
    return {
      title: `${sistema ?? "Un sistema"} no respondió`,
      message:
        `No se pudo ${tarea}${con} porque el servicio no respondió a tiempo. ` +
        `Suele resolverse solo; si el aviso se repite, avísanos.`,
    };
  }

  // Sin traducción: se dice qué dejó de pasar y que alguien lo revisará. El
  // detalle técnico vive en el registro, no en la cara del usuario.
  return {
    title: `No se pudo ${tarea}`,
    message:
      `Falló al ${tarea}${con} y se reintentó varias veces sin éxito. El ` +
      `dato quedó guardado en la plataforma; lo que no se completó es el ` +
      `envío al otro sistema. Ya quedó registrado para revisarlo.`,
  };
}
