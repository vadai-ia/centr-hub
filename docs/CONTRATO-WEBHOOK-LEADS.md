# Cómo conectar tu formulario a Centr Hub (Webhook de leads)

Este documento explica cómo hacer que un formulario de tu página web, una
landing de campaña o una herramienta como Zapier/Make **cree leads
automáticamente en Centr Hub**. Está pensado para que lo pueda seguir alguien
no técnico junto con quien administra el formulario.

Cada lead que entra por aquí es un lead **de primera clase**: se crea igual que
si lo hubieras dado de alta a mano en la plataforma (aparece en Contactos, se le
asigna un asesor, entra al pipeline y se crea su contacto en WhatsApp/Whaapy).

---

## 1. Qué necesitas: la URL y el token

Cada **fuente** (por ejemplo, "Formulario de la Home" o "Landing Verano") tiene
su **propia dirección (URL)** y su **propia contraseña (token)**. Así puedes
identificar de dónde vino cada lead y desactivar o cambiar una fuente sin afectar
a las demás.

Para obtenerlos:

1. En Centr Hub, entra a **Administración → Webhooks de leads**.
2. Haz clic en **“+ Nueva fuente”** y ponle un nombre (por ejemplo,
   “Formulario Contacto Web”).
3. La plataforma te mostrará **la URL** y **el token**.
   > ⚠️ **Copia el token en ese momento.** Por seguridad, **no se vuelve a
   > mostrar**. Si lo pierdes, entra a la fuente y usa **“Rotar token”** para
   > generar uno nuevo (el anterior deja de funcionar).

La URL se ve así:

```
https://TU-DOMINIO/api/webhooks/leads/UNCODIGOLARGO
```

---

## 2. Cómo enviar un lead

Tu formulario (o tu herramienta de automatización) debe hacer una petición
**POST** a la URL de la fuente, mandando los datos del lead en formato **JSON**,
e incluir el token como credencial.

**Detalles técnicos (para quien configura el formulario):**

- **Método:** `POST`
- **URL:** la de la fuente (paso 1)
- **Encabezados (headers):**
  - `Content-Type: application/json`
  - `x-centrhub-token: EL-TOKEN-DE-LA-FUENTE`
    *(alternativamente `Authorization: Bearer EL-TOKEN`, o mandar el token dentro del propio JSON en el campo `token`)*

---

## 3. Qué datos enviar (campos)

| Campo | ¿Obligatorio? | Descripción | Ejemplo |
|-------|---------------|-------------|---------|
| `name` | **Sí** | Nombre del lead | `"María López"` |
| `phone` | **Sí** | Teléfono con lada. Ideal en formato internacional. | `"+52 55 1234 5678"` |
| `email` | No | Correo del lead | `"maria@ejemplo.com"` |
| `address` | No | Dirección. Puede ser un texto simple o un objeto con campos. | ver abajo |
| `external_id` | No | Identificador único del envío (evita duplicados si se reintenta). | `"form-abc-123"` |
| `message` | No | Lo que escribió el visitante. Queda como nota de la oportunidad y en la historia del contacto. | `"Quiero cotizar una cocina"` |

**Notas importantes:**

- **El teléfono es obligatorio y debe ser un número real** (con lada). Es lo que
  usamos para no duplicar contactos y para crear la conversación en WhatsApp.
- **`email` y `address` son opcionales**: el lead se crea perfectamente sin ellos.
- **`message` es opcional pero muy recomendable**: es el contexto con el que el
  vendedor abre la oportunidad. Si el contacto ya existía y tenía una
  oportunidad activa, el mensaje igual queda registrado en su historia.
- La **dirección** puede enviarse de dos maneras:
  - Como texto simple: `"address": "Av. Reforma 123, CDMX"`
  - Como objeto con campos: `"address": { "address1": "Av. Reforma 123", "city": "CDMX", "province": "CDMX", "zip": "06600", "country": "México" }`

---

## 4. Ejemplo de envío

Ejemplo con `curl` (una herramienta de línea de comandos); tu formulario o Zapier
harán lo mismo internamente:

```bash
curl -X POST "https://TU-DOMINIO/api/webhooks/leads/UNCODIGOLARGO" \
  -H "Content-Type: application/json" \
  -H "x-centrhub-token: EL-TOKEN-DE-LA-FUENTE" \
  -d '{
    "name": "María López",
    "phone": "+52 55 1234 5678",
    "email": "maria@ejemplo.com",
    "address": "Av. Reforma 123, CDMX",
    "message": "Quiero cotizar una cocina integral",
    "external_id": "form-2026-000123"
  }'
```

Payload mínimo (solo lo obligatorio):

```json
{
  "name": "Juan Pérez",
  "phone": "5544332211"
}
```

---

## 5. Qué responde la plataforma

| Código | Significado | Qué hacer |
|--------|-------------|-----------|
| **202** | ✅ Recibido. El lead se está creando. | Todo bien. |
| **200** *(“duplicate”)* | Ya habíamos recibido este mismo envío (mismo `external_id` o mismo contenido). | Todo bien, no se duplica. |
| **401** *(“invalid_token”)* | El token es incorrecto o falta. | Revisa que estás mandando el token correcto de esa fuente. |
| **403** *(“revoked”)* | La fuente fue **revocada** en la plataforma. | Reactívala en Admin → Webhooks de leads, o usa otra fuente. |
| **404** *(“not_found”)* | La URL no corresponde a ninguna fuente. | Revisa que copiaste la URL completa y correcta. |
| **422** *(“invalid_payload”)* | Faltan datos obligatorios o tienen formato inválido (por ej. falta `name` o `phone`). | La respuesta indica qué campo falló. Corrige el formulario. |
| **429** *(“rate_limited”)* | Demasiados envíos en muy poco tiempo desde esa fuente. | Espera un momento y reintenta. |
| **400** *(“invalid_json”)* | El contenido no es un JSON válido. | Revisa que el formulario envíe JSON bien formado. |

---

## 6. Preguntas frecuentes

**¿A quién se le asigna el lead?**
A un asesor, de forma automática y equitativa (reparto rotativo entre los
vendedores activos). Si en ese momento no hay vendedores activos, el lead queda
sin asignar y se avisa al administrador.

**¿Y si el contacto ya existía?**
No se duplica. Se enlaza al contacto que ya teníamos (por teléfono o correo) y,
si no tenía una oportunidad activa, se le crea una nueva en la etapa “Lead nuevo”.

**¿Esto crea al cliente en Shopify?**
No. La creación en Shopify sigue siendo manual, desde el botón existente en la
plataforma. Este webhook solo crea el lead y su contacto de WhatsApp.

**¿Cómo cambio o desactivo una fuente?**
En **Admin → Webhooks de leads**: “Revocar” la desactiva (deja de aceptar
envíos) y “Rotar token” genera una credencial nueva. Cada fuente es
independiente.

**¿Puedo llamarlo desde el JavaScript de mi página (no desde un servidor)?**
Sí. El endpoint acepta peticiones desde el navegador, incluso de otro dominio.
Ten en cuenta que **el token queda a la vista** en el código de la página, como
en cualquier formulario público. Por eso, para ese uso:

- Crea una **fuente dedicada** para esa página (no reutilices la de Zapier ni la
  de otro formulario). Si alguien la usa para mandar basura, la revocas sin
  afectar nada más.
- El endpoint sólo puede **crear leads** y está limitado a **120 envíos por
  minuto** por fuente.
- Conviene incluir un **campo trampa** oculto en el formulario (los bots lo
  llenan, las personas no) y descartar el envío si viene lleno.

Ejemplo de referencia listo para pegar en un tema de Shopify:
`docs/widget-chat-shopify.liquid`.
