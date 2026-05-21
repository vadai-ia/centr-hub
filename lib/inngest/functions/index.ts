import "server-only";
import { customerFunctions } from "./customers";
import { draftOrderFunctions } from "./draft-orders";
import { orderFunctions } from "./orders";
import { dlqFunctions } from "./dlq";

/**
 * Registro completo de funciones Inngest para servir desde
 * `/api/inngest`. Cuando M4 agregue workers Whaapy, exportarlos
 * desde su propio archivo y concatenar al array.
 */
export const allFunctions = [
  ...customerFunctions,
  ...draftOrderFunctions,
  ...orderFunctions,
  ...dlqFunctions,
];
