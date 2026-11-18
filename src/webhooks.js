import express, { Router } from 'express';
import { v1 as uuidv1 } from 'uuid';
import * as db from './db.js';
import { aMicro } from './unidades.js';
import { verificarWebhookBridge } from './bridge.js';

export const webhooks = Router();

// ───────────── Juno ─────────────
const IPS_JUNO = {
  stage: ['3.129.233.228', '3.22.247.241', '3.134.133.168'],
  production: ['52.15.91.227', '18.216.72.107', '18.219.140.132'],
};
const permitidas = new Set(IPS_JUNO[process.env.JUNO_ENTORNO ?? 'production']);
const ipOrigen = (req) => (req.ip ?? '').replace(/^::ffff:/, '');

async function manejarEmision(payload) {
  const emision = payload.issuance;
  if (emision?.method !== 'SPEI' || !emision.deposit_receiver_clabe) {
    console.warn('Emisión sin CLABE de SPEI, se ignora:', payload.id);
    return;
  }
  let monto;
  try {
    monto = aMicro(emision.amount);
  } catch {
    console.error('Monto de emisión inválido, revisar a mano:', payload.id, emision.amount);
    return;
  }
  const perfil = await db.obtenerPerfilPorClabe(emision.deposit_receiver_clabe);
  const nuevo = await db.registrarDeposito({
    junoTxId: payload.id,
    userId: perfil?.userId ?? null,
    clabe: emision.deposit_receiver_clabe,
    monto,
    idemKey: uuidv1(),
  });
  if (nuevo && !perfil) console.warn('Depósito sin usuario para la CLABE:', emision.deposit_receiver_clabe);
}

async function manejarDepositoCripto(payload) {
  const dep = payload.crypto_deposit;
  if (!dep || String(dep.asset).toUpperCase() !== 'MXNB') return;
  let monto;
  try {
    monto = aMicro(dep.amount);
  } catch {
    console.error('Monto de depósito cripto inválido:', payload.id, dep.amount);
    return;
  }
  const r = await db.asignarDepositoCripto({
    walletOrigen: String(dep.crypto_source_address ?? '').toLowerCase(),
    monto,
    junoDepositoId: payload.id,
  });
  if (r === null) {
    console.warn('Depósito cripto sin retiro asociado, revisar a mano:', payload.id, dep.crypto_source_address);
  }
}

async function manejarConversion(payload, ok) {
  let montoUsdc = null;
  const conv = payload.conversion ?? payload;
  const targetAmount = conv?.target_amount ?? conv?.credited_amount;
  if (ok && targetAmount) {
    try {
      montoUsdc = aMicro(targetAmount);
    } catch {
      console.warn('No se pudo parsear target_amount de conversión:', payload.id, targetAmount);
    }
  }
  await db.resolverConversion(payload.id, ok, montoUsdc);
}

async function procesarEventoJuno(payload) {
  const ok = payload.status === 'COMPLETE';
  switch (payload.type) {
    case 'ISSUANCE':
      if (ok) await manejarEmision(payload);
      break;
    case 'CRYPTO_DEPOSIT':
      if (ok) await manejarDepositoCripto(payload);
      break;
    case 'CRYPTO_WITHDRAWAL':
      await db.resolverRetiroDeposito(payload.id, ok);
      break;
    case 'REDEMPTION':
      await db.resolverRedencion(payload.id, ok);
      break;
    case 'CONVERSION':
      await manejarConversion(payload, ok);
      break;
    default:
      break;
  }
}

webhooks.post('/webhooks/juno', express.json({ limit: '100kb' }), async (req, res) => {
  if (!permitidas.has(ipOrigen(req))) return res.status(403).send('IP no permitida');

  const { event, payload } = req.body ?? {};
  if (event !== 'TRANSACTION' || !payload?.id || !payload?.type || !payload?.status) {
    return res.status(400).send('Payload inválido');
  }

  try {
    const ahora = new Date().toISOString();
    await db.registrarEventoJuno({
      id: payload.id,
      tipo: payload.type,
      estado: payload.status,
      payload,
      creadoEn: payload.created_at ?? ahora,
      actualizadoEn: payload.updated_at ?? ahora,
    });
    if (payload.status === 'COMPLETE' || payload.status === 'FAILED') {
      await procesarEventoJuno(payload);
    }
    return res.status(200).send('OK');
  } catch (error) {
    console.error('webhook juno:', error);
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
