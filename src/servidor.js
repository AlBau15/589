import crypto from 'node:crypto';
import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { PrivyClient } from '@privy-io/server-auth';
import { getAddress } from 'viem';
import * as chain from './chain.js';
import * as db from './db.js';
import { rutasOnboarding } from './onboarding.js';
import {
  procesarDepositos,
  procesarRetirosMx,
  procesarSalidasUs,
  rutasSalidas,
  sincronizarRetirosBitso,
} from './salidas.js';
import { deMicro, seguro } from './unidades.js';
import { webhooks } from './webhooks.js';

const app = express();
// Número de proxies inversos delante del servidor. Por defecto 0: no se confía en X-Forwarded-For,
// que cualquier cliente puede falsificar. Pon el número exacto de proxies (p. ej. 1 detrás de un
// balanceador); un valor mayor permitiría suplantar IPs, incluidas las de Juno.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 0));

app.use(webhooks);
app.use(express.json({ limit: '10kb' }));

const privy = new PrivyClient(process.env.PRIVY_APP_ID, process.env.PRIVY_APP_SECRET);

async function autenticar(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ exito: false, error: 'Token ausente' });
    const claims = await privy.verifyAuthToken(token);
    req.userId = claims.userId;
    next();
  } catch {
    res.status(401).json({ exito: false, error: 'No autorizado' });
  }
}

// Tiempo que tiene el comprador para pagar una orden antes de que caduque en el contrato
const VIGENCIA_ORDEN_SEGUNDOS = BigInt(process.env.ORDEN_VIGENCIA_SEGUNDOS ?? 900);

const limitador = rateLimit({ windowMs: 60_000, limit: 10, keyGenerator: (req) => req.userId ?? ipKeyGenerator(req.ip ?? '') });
const comunes = { autenticar, limitador };

app.use(rutasOnboarding({ privy, ...comunes }));
app.use(rutasSalidas(comunes));

// ───────────── Órdenes de compra ─────────────
app.post(
  '/api/ordenes',
  autenticar,
  limitador,
  seguro(async (req, res) => {
    const itemId = req.body?.itemId;
    const item = typeof itemId === 'string' ? await db.obtenerItem(itemId) : null;
    if (!item) return res.status(404).json({ exito: false, error: 'Artículo no encontrado' });

    const perfil = await db.obtenerPerfil(req.userId);
    if (!perfil || perfil.estado !== 'completo') {
      return res.status(409).json({ exito: false, error: 'Completa el onboarding' });
    }

    const comprador = getAddress(perfil.wallet);
    const creador = getAddress(item.creadorWallet.toLowerCase());
    if ((await chain.saldoMxnb(comprador)) < item.monto) {
      return res.status(402).json({ exito: false, error: 'Saldo insuficiente' });
    }

    const orderId = crypto.randomBytes(16).toString('hex');
    const expiraEn = BigInt(Math.floor(Date.now() / 1000)) + VIGENCIA_ORDEN_SEGUNDOS;
    await db.guardarOrden({ orderId, userId: req.userId, itemId, monto: item.monto, comprador, creador, expiraEn });

    // Firma EIP-712 fuera de la cadena: no hay transacción del operador ni gas por orden.
    let pago;
    try {
      pago = await chain.firmarOrdenPago({ orderId, comprador, creador, monto: item.monto, expiraEn });
    } catch (error) {
      await db.marcarOrdenCancelada(orderId);
      throw error;
    }

    return res.json({
      exito: true,
      orderId,
      monto: deMicro(item.monto),
      expiraEn: new Date(Number(expiraEn) * 1000).toISOString(),
      calls: chain.callsPago(pago),
    });
  })
);

app.get(
  '/api/ordenes/:orderId',
  autenticar,
  seguro(async (req, res) => {
    const orden = await db.obtenerOrdenDeUsuario(req.params.orderId, req.userId);
    if (!orden) return res.status(404).json({ exito: false, error: 'No encontrada' });
    return res.json({ exito: true, estado: orden.estado, txHash: orden.txHash });
  })
);

// ───────────── Confirmación de pagos ─────────────

async function alPagarOrden({ orderId, txHash }) {
  const primera = await db.marcarOrdenPagada(orderId, txHash);
  if (primera) {
    console.log(`Orden pagada: ${orderId} (${txHash})`);
  }
}

// Margen sobre expiraEn antes de dar una orden por caducada, por si el reloj local va adelantado
// respecto al de la cadena o queda un bloque en camino.
const MARGEN_CADUCIDAD_MS = 60_000;

async function reconciliarOrdenes() {
  for (const { orderId, expiraEn } of await db.ordenesPendientesAntiguas(60)) {
    const estado = await chain.estadoOrden(orderId);
    if (estado.pagada) await alPagarOrden({ orderId, txHash: null });
    // Una orden caducada ya no se puede pagar en el contrato, así que se da por cancelada.
    else if (estado.cancelada || Date.now() > expiraEn.getTime() + MARGEN_CADUCIDAD_MS) {
      await db.marcarOrdenCancelada(orderId);
    }
  }
}

// ───────────── Arranque ─────────────

function ciclo(nombre, fn, cadaMs) {
  let corriendo = false;
  setInterval(async () => {
    if (corriendo) return;
    corriendo = true;
    try {
      await fn();
    } catch (error) {
      console.error(`trabajador ${nombre}:`, error);
    } finally {
      corriendo = false;
    }
  }, cadaMs);
}

app.listen(process.env.PORT ?? 3000, () => {
  console.log('Orquestador corriendo');
  if (process.env.EJECUTAR_TRABAJADORES === '0') return;
  chain.vigilarCompras(alPagarOrden);
  ciclo('depositos', procesarDepositos, 10_000);
  ciclo('retiros-mx', procesarRetirosMx, 10_000);
  ciclo('salidas-us', procesarSalidasUs, 15_000);
  ciclo('retiros-bitso', sincronizarRetirosBitso, 30_000);
  ciclo('reconciliar-ordenes', reconciliarOrdenes, 30_000);
});
