// Clasificación de errores en operaciones que mueven dinero.
import { JunoError } from './juno.js';

// ¿Es seguro reintentar una operación que falló?
//  - Si el error ocurrió antes de intentar mover el dinero, sí.
//  - Si ya se intentó, solo cuando el proveedor rechazó la petición de forma explícita (4xx): entonces
//    no se procesó. 408 (timeout) y 409 (conflicto/duplicado) indican que pudo procesarse.
//  - Timeouts, errores de red, 5xx o cualquier otro error tras intentarlo son ambiguos: el dinero pudo
//    salir y reintentar arriesga un doble envío. Esos casos van a revisión manual.
export function puedeReintentarse(error, { envioIntentado }) {
  if (!envioIntentado) return true;
  return (
    error instanceof JunoError &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 409
  );
}
