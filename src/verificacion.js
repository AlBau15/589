// Verificación de webhooks de Juno contra su API.
//
// Un webhook solo prueba que alguien hizo una petición HTTP; la lista blanca de IPs depende de que
// TRUST_PROXY_HOPS esté bien configurado. Por eso el tipo, el estado, el monto y los datos que deciden a
// quién se paga se toman SIEMPRE de GET /mint_platform/v1/transactions/{id}, nunca del cuerpo del webhook.
// Si a la respuesta de Juno le falta un dato necesario, se rechaza (falla cerrada) en vez de usar el webhook.

export class VerificacionError extends Error {}

const primero = (...valores) => valores.find((v) => v !== undefined && v !== null && v !== '');

// Busca un campo en la raíz, en typed_details/details y en el objeto específico del tipo
// (issuance, crypto_deposit, conversion...), que es como lo presentan los webhooks.
function campo(tx, nombres) {
  const lugares = [tx, tx.typed_details, tx.details, tx.issuance, tx.crypto_deposit, tx.conversion];
  for (const lugar of lugares) {
    if (!lugar || typeof lugar !== 'object') continue;
    const valor = primero(...nombres.map((n) => lugar[n]));
    if (valor !== undefined) return valor;
  }
  return undefined;
}

// Devuelve los datos confirmados de la transacción, o lanza VerificacionError.
export function confirmarTransaccion(idWebhook, tx) {
  if (!tx || typeof tx !== 'object') throw new VerificacionError('Juno no devolvió la transacción');
  if (String(tx.id) !== String(idWebhook)) {
    throw new VerificacionError(`La transacción de Juno (${tx.id}) no coincide con el webhook (${idWebhook})`);
  }
  const tipo = primero(tx.transaction_type, tx.type);
  const estado = tx.status;
  if (!tipo || !estado) throw new VerificacionError(`Respuesta de Juno sin tipo o estado para ${idWebhook}`);

  return {
    id: String(tx.id),
    tipo: String(tipo).toUpperCase(),
    estado: String(estado).toUpperCase(),
    monto: campo(tx, ['amount']),
    metodo: campo(tx, ['method', 'payment_method']),
    clabe: campo(tx, ['deposit_receiver_clabe', 'receiver_clabe', 'clabe']),
    activo: campo(tx, ['asset', 'currency']),
    origenCripto: campo(tx, ['crypto_source_address', 'source_address', 'from_address']),
    montoDestino: campo(tx, ['target_amount', 'credited_amount']),
  };
}

// Exige que un dato confirmado exista; si no, falla cerrada.
export function requerido(confirmada, nombre) {
  const valor = confirmada[nombre];
  if (valor === undefined || valor === null || valor === '') {
    throw new VerificacionError(
      `La respuesta de Juno para ${confirmada.id} (${confirmada.tipo}) no incluye '${nombre}'; ` +
        'revisa el formato de GET /mint_platform/v1/transactions/{id} en src/verificacion.js'
    );
  }
  return valor;
}
