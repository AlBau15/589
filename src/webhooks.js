import express, { Router } from 'express';
import { v1 as uuidv1 } from 'uuid';
import * as db from './db.js';
import * as juno from './juno.js';
import { aMicro } from './unidades.js';
import { verificarWebhookBridge } from './bridge.js';
import { confirmarTransaccion, requerido, VerificacionError } from './verificacion.js';

export const webhooks = Router();

// ───────────── Juno ─────────────
const IPS_JUNO = {
  stage: ['3.129.233.228', '3.22.247.241', '3.134.133.168'],
  production: ['52.15.91.227', '18.216.72.107', '18.219.140.132'],
};
const permitidas = new Set(IPS_JUNO[process.env.JUNO_ENTORNO ?? 'production']);
const ipOrigen = (req) => (req.ip ?? '').replace(/^::ffff:/, '');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Todas las funciones reciben la transacción CONFIRMADA con la API de Juno (src/verificacion.js).

async function manejarEmision(tx) {
  if (tx.metodo && String(tx.metodo).toUpperCase() !== 'SPEI') {
    console.warn('Emisión que no es por SPEI, se ignora:', tx.id, tx.metodo);
    return;
  }
  const clabe = String(requerido(tx, 'clabe'));
  const monto = aMicro(requerido(tx, 'monto'));
  if (monto <= 0n) return console.warn('Emisión con monto 0, se ignora:', tx.id);
  const perfil = await db.obtenerPerfilPorClabe(clabe);
  const nuevo = await db.registrarDeposito({
    junoTxId: tx.id,
    userId: perfil?.userId ?? null,
    clabe,
    monto,
    idemKey: uuidv1(),
  });
  if (nuevo && !perfil) console.warn('Depósito sin usuario para la CLABE:', clabe);
}

async function manejarDepositoCripto(tx) {
  if (String(requerido(tx, 'activo')).toUpperCase() !== 'MXNB') return;
  const monto = aMicro(requerido(tx, 'monto'));
  if (monto <= 0n) return console.warn('Depósito cripto con monto 0, se ignora:', tx.id);
  const walletOrigen = String(requerido(tx, 'origenCripto')).toLowerCase();
  const r = await db.asignarDepositoCripto({ walletOrigen, monto, junoDepositoId: tx.id });
  if (r === 'reactivado') {
    console.warn('Depósito cripto tras expirar el retiro: se reactivó y se procesará:', tx.id, walletOrigen);
  } else if (r === null) {
    console.error('Depósito cripto sin retiro asociado, REVISAR A MANO (los fondos están en Juno):', tx.id, walletOrigen);
  }
}

async function manejarConversion(tx, ok) {
  let montoUsdc = null;
  if (ok && tx.montoDestino) {
    try {
      montoUsdc = aMicro(tx.montoDestino);
    } catch {
      console.warn('No se pudo leer el monto convertido, se usa el de la cotización:', tx.id, tx.montoDestino);
    }
  }
  await db.resolverConversion(tx.id, ok, montoUsdc);
}

async function procesarEventoJuno(tx) {
  const ok = tx.estado === 'COMPLETE';
  switch (tx.tipo) {
    case 'ISSUANCE':
      if (ok) await manejarEmision(tx);
      break;
    case 'CRYPTO_DEPOSIT':
      if (ok) await manejarDepositoCripto(tx);
      break;
    case 'CRYPTO_WITHDRAWAL':
      await db.resolverRetiroDeposito(tx.id, ok);
      break;
    case 'REDEMPTION':
      await db.resolverRedencion(tx.id, ok);
      break;
    case 'CONVERSION':
      await manejarConversion(tx, ok);
      break;
    default:
      break;
  }
}

webhooks.post('/webhooks/juno', express.json({ limit: '100kb' }), async (req, res) => {
  if (!permitidas.has(ipOrigen(req))) return res.status(403).send('IP no permitida');

  const { event, payload } = req.body ?? {};
  if (event !== 'TRANSACTION' || typeof payload?.id !== 'string' || !UUID.test(payload.id)) {
    return res.status(400).send('Payload inválido');
  }

  try {
    // El webhook solo dice "revisa la transacción X": los datos se piden a Juno.
    let respuesta;
    try {
      respuesta = await juno.obtenerTransaccion(payload.id);
    } catch (error) {
      if (error instanceof juno.JunoError && error.status === 404) {
        console.warn('Webhook de Juno con una transacción que Juno no conoce, se ignora:', payload.id);
        return res.status(404).send('Transacción desconocida');
      }
      throw error;
    }
    const tx = confirmarTransaccion(payload.id, respuesta);

    const ahora = new Date().toISOString();
    await db.registrarEventoJuno({
      id: tx.id,
      tipo: tx.tipo,
      estado: tx.estado,
      payload: respuesta,
      creadoEn: respuesta.created_at ?? ahora,
      actualizadoEn: respuesta.updated_at ?? ahora,
    });
    if (tx.estado === 'COMPLETE' || tx.estado === 'FAILED') {
      await procesarEventoJuno(tx);
    }
    return res.status(200).send('OK');
  } catch (error) {
    // 500: Juno reintentará el webhook (p. ej. si su API falló o hay que ajustar src/verificacion.js)
    console.error('webhook juno:', payload.id, error instanceof VerificacionError ? error.message : error);
    return res.status(500).send('Error interno');
  }
});

// ───────────── Bridge ─────────────
webhooks.post('/webhooks/bridge', express.raw({ type: '*/*', limit: '200kb' }), async (req, res) => {
  if (!verificarWebhookBridge(req.body, req.headers['x-webhook-signature'])) {
    return res.status(400).send('Firma inválida');
  }
  let evento;
  try {
    evento = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).send('JSON inválido');
  }
  try {
    const eventId = evento.event_id ?? evento.id;
    const tipo = evento.event_type ?? evento.type ?? null;
    await db.registrarEventoBridge({ eventId, tipo, payload: evento });

    // Si Bridge confirma la liquidación ACH asociada a un tx_hash de depósito, cerramos el ciclo
    const txHash =
      evento.data?.source_deposit_instructions?.tx_hash ??
      evento.event_object?.deposit_tx_hash ??
      evento.data?.deposit_tx_hash ??
      null;
    const estadoEvento = String(evento.data?.state ?? evento.event_object?.state ?? '').toLowerCase();

    if (txHash && (estadoEvento === 'payment_processed' || estadoEvento === 'completed')) {
      await db.completarSalidaUsPorBridge(txHash);
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('webhook bridge:', error);
    return res.status(500).send('Error interno');
  }
});
