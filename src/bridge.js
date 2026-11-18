// Cliente de Bridge (Stripe) para la ruta B (USDC -> USD por ACH)
import crypto from 'node:crypto';
import * as db from './db.js';

const BASE = process.env.BRIDGE_API_URL ?? 'https://api.bridge.xyz/v0';

async function llamar(metodo, ruta, cuerpo, idemKey) {
  const res = await fetch(BASE + ruta, {
    method: metodo,
    headers: {
      'Api-Key': process.env.BRIDGE_API_KEY,
      'Content-Type': 'application/json',
      'Idempotency-Key': idemKey,
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Bridge ${metodo} ${ruta} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

export async function asegurarDireccionLiquidacion() {
  const existente = await db.obtenerBridgeCuenta();
  if (existente) return existente;

  const customerId = process.env.BRIDGE_CUSTOMER_ID;
  const externalAccountId = process.env.BRIDGE_EXTERNAL_ACCOUNT_ID;
  const r = await llamar(
    'POST',
    `/customers/${customerId}/liquidation_addresses`,
    {
      chain: 'arbitrum',
      currency: 'usdc',
      external_account_id: externalAccountId,
      destination_payment_rail: 'ach',
      destination_currency: 'usd',
      return_instructions: { address: process.env.BRIDGE_RETURN_ADDRESS },
    },
    `liq-addr-plataforma-${customerId}`
  );

  const cuenta = {
    customerId,
    externalAccountId,
    liquidationAddressId: r.id,
    liquidationAddress: r.address,
    chain: r.chain,
  };
  await db.guardarBridgeCuenta(cuenta);
  return cuenta;
}

export function verificarWebhookBridge(cuerpoCrudo, cabecera) {
  if (!process.env.BRIDGE_WEBHOOK_PUBLIC_KEY || !Buffer.isBuffer(cuerpoCrudo)) return false;
  const m = /^t=(\d+),v0=([A-Za-z0-9+/=]+)$/.exec(cabecera ?? '');
  if (!m) return false;
  const [, marca, firmaB64] = m;
  if (Math.abs(Date.now() - Number(marca)) > 10 * 60 * 1000) return false;

  const digest = crypto.createHash('sha256').update(`${marca}.`).update(cuerpoCrudo).digest();
  try {
    return crypto.verify(
      'sha256',
      digest,
      process.env.BRIDGE_WEBHOOK_PUBLIC_KEY.replace(/\\n/g, '\n'),
      Buffer.from(firmaB64, 'base64')
    );
  } catch {
    return false;
  }
}
