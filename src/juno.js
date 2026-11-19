// Cliente de la API Mint Platform de Juno y Payouts de Bitso (USDC Multi-Network).
import crypto from 'node:crypto';
import { v1 as uuidv1 } from 'uuid';
import { aMicro } from './unidades.js';

export const nuevaIdemKey = uuidv1;

export class JunoError extends Error {
  constructor(mensaje, { status, cuerpo } = {}) {
    super(mensaje);
    this.status = status;
    this.cuerpo = cuerpo;
  }
}

let ultimoNonce = 0;
const siguienteNonce = () => {
  ultimoNonce = Math.max(Date.now(), ultimoNonce + 1);
  return String(ultimoNonce);
};

async function llamar(metodo, ruta, cuerpo, { idemKey, baseUrl } = {}) {
  const body = cuerpo === undefined ? '' : JSON.stringify(cuerpo);
  const nonce = siguienteNonce();
  const firma = crypto
    .createHmac('sha256', process.env.JUNO_API_SECRET)
    .update(`${nonce}${metodo}${ruta}${body}`)
    .digest('hex');

  const headers = {
    Authorization: `Bitso ${process.env.JUNO_API_KEY}:${nonce}:${firma}`,
    'Content-Type': 'application/json',
  };
  if (process.env.JUNO_BEARER_TOKEN) headers.BitsoAuth = `Bearer ${process.env.JUNO_BEARER_TOKEN}`;
  if (idemKey) headers['X-Idempotency-Key'] = idemKey;

  const host = baseUrl ?? process.env.JUNO_BASE_URL;
  const res = await fetch(host + ruta, {
    method: metodo,
    headers,
    body: body || undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const texto = await res.text();
  let json;
  try {
    json = JSON.parse(texto);
  } catch {
    json = { raw: texto };
  }
  if (!res.ok || json.success === false) {
    throw new JunoError(`Juno/Bitso ${metodo} ${ruta} -> ${res.status}`, { status: res.status, cuerpo: json });
  }
  return json;
}

const extraerId = (r) => r?.payload?.id ?? r?.payload?.wid ?? r?.payload?.transaction_id ?? r?.id ?? null;

export async function crearClabe() {
  const r = await llamar('POST', '/mint_platform/v1/clabes');
  return r.payload.clabe;
}

export const registrarWallet = ({ tag, address }) =>
  llamar('POST', '/mint_platform/v1/accounts/blockchain', { tag, network: 'arbitrum', address });

export async function retirarMxnb({ address, monto, idemKey }) {
  const limite = process.env.JUNO_LIMITE_TRAVEL_RULE_MXNB;
  if (limite && aMicro(monto) > aMicro(limite)) {
    throw new JunoError('El monto requiere datos de Travel Rule');
  }
  const r = await llamar(
    'POST',
    '/mint_platform/v1/withdrawals',
    { blockchain: 'ARBITRUM', asset: 'MXNB', amount: String(monto), address, compliance: {} },
    { idemKey }
  );
  return extraerId(r);
}

export async function redimir({ monto, bankAccountId, idemKey }) {
  const r = await llamar(
    'POST',
    '/mint_platform/v1/redemptions',
    { amount: String(monto), destination_bank_account_id: bankAccountId, asset: 'MXN' },
    { idemKey }
  );
  return extraerId(r);
}

// Conversión MXNB -> USDC dentro de Juno (mínimo 25,000 MXNB)
export async function cotizar({ origen, destino, montoOrigen }) {
  const r = await llamar('POST', '/mint_platform/v1/quotes', {
    source_asset: origen,
    target_asset: destino,
    source_amount: String(montoOrigen),
  });
  return r.payload ?? r;
}

export async function ejecutarConversion({ quoteId, externalRef }) {
  const r = await llamar('POST', '/mint_platform/v2/transactions', {
    type: 'CONVERSION',
    external_ref: externalRef,
    conversion: { quote_id: quoteId },
  });
  return extraerId(r);
}

// Retiro de USDC hacia una dirección externa (p. ej. liquidation_address de Bridge)
// utilizando el endpoint de retiros multi-red de Bitso (comparte credenciales con Juno).
export async function retirarUsdcExterno({ address, montoUsdc, chain = 'ARB', originId }) {
  const bitsoBase = process.env.BITSO_API_URL ?? process.env.JUNO_BASE_URL;
  const payload = {
    asset: 'usdc',
    currency: 'usdc',
    method: 'usdc_trf',
    network: chain,
    chain,
    amount: String(montoUsdc),
    address,
    origin_id: originId,
  };
  if (process.env.BITSO_BRIDGE_CONTACT_ID) {
    payload.contact_id = process.env.BITSO_BRIDGE_CONTACT_ID;
  }
  // origin_id y la clave de idempotencia son el id del lote: un reintento no crea un segundo retiro
  // si Bitso los respeta. Aun así, procesarSalidasUs no reintenta errores ambiguos.
  const r = await llamar('POST', '/v3/withdrawals', payload, { baseUrl: bitsoBase, idemKey: originId });
  return extraerId(r);
}

// Consulta un retiro de USDC creado con retirarUsdcExterno para obtener su estado y tx hash en cadena
export async function obtenerRetiroUsdcExterno(wid) {
  const bitsoBase = process.env.BITSO_API_URL ?? process.env.JUNO_BASE_URL;
  const r = await llamar('GET', `/v3/withdrawals/${encodeURIComponent(wid)}`, undefined, { baseUrl: bitsoBase });
  const p = Array.isArray(r.payload) ? r.payload[0] : r.payload;
  return { estado: p?.status ?? null, txHash: p?.details?.tx_hash ?? p?.tx_hash ?? null };
}

// Detalle de una transacción por su id (requiere el permiso "View account information" en la API key).
// Los webhooks se tratan solo como aviso: lo que mueve dinero se toma de aquí.
export async function obtenerTransaccion(id) {
  const r = await llamar('GET', `/mint_platform/v1/transactions/${encodeURIComponent(id)}`);
  return r.payload ?? r;
}
