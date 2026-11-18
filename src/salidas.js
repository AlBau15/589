// Rutas de salida
//   A) México: MXNB de la wallet del creador -> Juno -> redención SPEI a su banco
//   B) EE. UU.: tesorería MXNB -> USDC (Juno) -> Bridge -> ACH USD
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { getAddress } from 'viem';
import * as bridge from './bridge.js';
import * as chain from './chain.js';
import * as db from './db.js';
import * as juno from './juno.js';
import { aMicro, deMicro, seguro } from './unidades.js';

const MINIMO_REDENCION = 100_000_000n; // 100 MXNB
const MINIMO_CONVERSION_USDC = 25_000_000_000n; // 25,000 MXNB

// Middleware para proteger endpoints internos de tesorería (Ruta B)
function autenticarAdmin(req, res, next) {
  const secret = process.env.ADMIN_API_SECRET;
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (!secret || auth !== secret) {
    return res.status(401).json({ exito: false, error: 'No autorizado para operaciones de tesorería' });
  }
  next();
}

// ───────────── Ruta A y Endpoints de Tesorería (Ruta B) ─────────────

export function rutasSalidas({ autenticar, limitador }) {
  const router = Router();

  // 1) Ruta A: El creador pide el retiro en México
  router.post(
    '/api/retiros/mx',
    autenticar,
    limitador,
    seguro(async (req, res) => {
      let monto;
      try {
        monto = aMicro(req.body?.monto);
      } catch {
        return res.status(400).json({ exito: false, error: 'Monto inválido' });
      }
      if (monto % 10_000n !== 0n) {
        return res.status(400).json({ exito: false, error: 'Máximo 2 decimales' });
      }
      if (monto < MINIMO_REDENCION) {
        return res.status(400).json({ exito: false, error: 'El mínimo de retiro es 100 MXNB' });
      }

      const perfil = await db.obtenerPerfil(req.userId);
      if (!perfil || perfil.estado !== 'completo') {
        return res.status(409).json({ exito: false, error: 'Completa el onboarding' });
      }
      if (!(await db.obtenerCuentaBancaria(req.userId))) {
        return res.status(409).json({ exito: false, error: 'Aún no tienes una cuenta bancaria registrada' });
      }
      if ((await chain.saldoMxnb(getAddress(perfil.wallet))) < monto) {
        return res.status(400).json({ exito: false, error: 'Saldo insuficiente' });
      }

      const id = await db.crearRetiroMx({
        userId: req.userId,
        monto,
        walletOrigen: perfil.wallet,
        idemKey: juno.nuevaIdemKey(),
      });
      if (!id) return res.status(409).json({ exito: false, error: 'Ya tienes un retiro en curso' });

      return res.json({
        exito: true,
        retiroId: id,
        destino: process.env.JUNO_DEPOSIT_ADDRESS,
        monto: deMicro(monto),
        token: chain.MXNB,
      });
    })
  );

  router.get(
    '/api/retiros/mx/:id',
    autenticar,
    seguro(async (req, res) => {
      const retiro = await db.obtenerRetiroMx(req.params.id, req.userId);
      if (!retiro) return res.status(404).json({ exito: false, error: 'No encontrado' });
      return res.json({ exito: true, estado: retiro.estado, monto: deMicro(retiro.monto) });
    })
  );

  // 2) Ruta B (Tesorería): Inicia lote de conversión MXNB -> USDC -> Bridge ACH
  router.post(
    '/api/tesoreria/salidas-us',
    autenticarAdmin,
    seguro(async (req, res) => {
      let montoMicro;
      try {
        montoMicro = aMicro(req.body?.montoMxnb);
      } catch {
        return res.status(400).json({ exito: false, error: 'Monto MXNB inválido' });
      }
      if (montoMicro < MINIMO_CONVERSION_USDC) {
        return res.status(400).json({
          exito: false,
          error: 'Juno exige un mínimo de 25,000 MXNB por lote de conversión a USDC',
        });
      }

      // Asegura previamente que la dirección de liquidación de Bridge exista antes de convertir
      const cuentaBridge = await bridge.asegurarDireccionLiquidacion();
      const salidaId = await convertirTesoreriaAUsdc(deMicro(montoMicro));

      return res.status(202).json({
        exito: true,
        salidaId,
        montoMxnb: deMicro(montoMicro),
        liquidationAddress: cuentaBridge.liquidationAddress,
        chain: cuentaBridge.chain,
      });
    })
  );

  // Consulta el estado de los lotes de liquidación hacia EE. UU.
  router.get(
    '/api/tesoreria/salidas-us',
    autenticarAdmin,
    seguro(async (_req, res) => {
      const lotes = await db.listarSalidasUs(25);
      return res.json({
        exito: true,
        lotes: lotes.map((l) => ({
          ...l,
          monto_mxnb: deMicro(l.monto_mxnb),
          monto_usdc: l.monto_usdc ? deMicro(l.monto_usdc) : null,
        })),
      });
    })
  );

  return router;
}

// ───────────── Trabajadores Ruta A ─────────────

export async function procesarDepositos() {
  await db.recuperarAtascados();
  for (;;) {
    const dep = await db.reclamarDeposito();
    if (!dep) break;
    try {
      const perfil = await db.obtenerPerfil(dep.userId);
      const id = await juno.retirarMxnb({
        address: getAddress(perfil.wallet),
        monto: deMicro(dep.monto),
        idemKey: dep.idemKey,
      });
      if (!id) console.error('Juno no devolvió id de retiro, revisar:', dep.junoTxId);
      await db.marcarDepositoEnviado(dep.junoTxId, id);
    } catch (error) {
      console.error('retiro a wallet falló:', dep.junoTxId, error.cuerpo ?? error);
      await db.liberarDeposito(dep.junoTxId);
    }
  }
}

export async function procesarRetirosMx() {
  await db.expirarRetirosMx();
  for (;;) {
    const retiro = await db.reclamarRedencion();
    if (!retiro) break;
    try {
      const cuenta = await db.obtenerCuentaBancaria(retiro.userId);
      if (!cuenta) throw new Error('El usuario no tiene cuenta bancaria registrada');
      const id = await juno.redimir({
        monto: deMicro(retiro.monto),
        bankAccountId: cuenta.junoBankAccountId,
        idemKey: retiro.idemKey,
      });
      if (!id) console.error('Juno no devolvió id de redención, revisar:', retiro.id);
      await db.marcarRedencionEnviada(retiro.id, id);
    } catch (error) {
      console.error('redención falló:', retiro.id, error.cuerpo ?? error);
      await db.liberarRedencion(retiro.id);
    }
  }
}

// ───────────── Trabajadores y Flujo Ruta B ─────────────

// Paso 1: Cotiza y ejecuta la conversión MXNB -> USDC dentro de Juno
export async function convertirTesoreriaAUsdc(montoMxnb) {
  const micro = aMicro(montoMxnb);
  if (micro < MINIMO_CONVERSION_USDC) {
    throw new Error('Juno exige al menos 25,000 MXNB por conversión a USDC');
  }
  const id = randomUUID();
  await db.registrarSalidaUs({ id, montoMxnb: micro });

  try {
    const cotizacion = await juno.cotizar({ origen: 'MXNB', destino: 'USDC', montoOrigen: deMicro(micro) });
    const montoUsdcEstimado = cotizacion.target_amount ? aMicro(cotizacion.target_amount) : null;
    const conversionId = await juno.ejecutarConversion({ quoteId: cotizacion.quote_id, externalRef: id });

    await db.actualizarSalidaUs(id, {
      estado: 'convirtiendo',
      monto_usdc: montoUsdcEstimado,
      juno_quote_id: cotizacion.quote_id,
      juno_conversion_id: conversionId,
    });
    return id;
  } catch (error) {
    await db.actualizarSalidaUs(id, { estado: 'fallido', detalle: { error: error.message } });
    throw error;
  }
}

// Paso 2 (IMPLEMENTADO): Envía el USDC convertido hacia la dirección de liquidación de Bridge en Arbitrum.
// Soporta dos modos configurables vía RUTA_B_MODO_RETIRO:
//   - 'bitso_api' (por defecto): usa el endpoint institucional de retiros USDC de Bitso (/v3/withdrawals)
//   - 'onchain_tesoreria': transfiere directamente desde la wallet operativa de tesorería en Arbitrum
export async function enviarUsdcABridge(salida) {
  const cuentaBridge = await bridge.asegurarDireccionLiquidacion();
  const modo = process.env.RUTA_B_MODO_RETIRO ?? 'bitso_api';

  if (modo === 'onchain_tesoreria') {
    const txHash = await chain.transferirUsdcTesoreria({
      destino: cuentaBridge.liquidationAddress,
      montoMicro: salida.montoUsdc,
    });
    return { txHashBridge: txHash, bitsoWithdrawalId: null };
  }

  const bitsoWithdrawalId = await juno.retirarUsdcExterno({
    address: cuentaBridge.liquidationAddress,
    montoUsdc: deMicro(salida.montoUsdc),
    chain: 'ARB',
    originId: salida.id,
  });
  return { txHashBridge: null, bitsoWithdrawalId };
}

// Trabajador asíncrono de Ruta B: reclama conversiones 'convertido' y las despacha a Bridge
export async function procesarSalidasUs() {
  for (;;) {
    const salida = await db.reclamarSalidaUs();
    if (!salida) break;
    try {
      const { txHashBridge, bitsoWithdrawalId } = await enviarUsdcABridge(salida);
      await db.actualizarSalidaUs(salida.id, {
        estado: 'enviado_bridge',
        tx_hash_bridge: txHashBridge,
        bitso_withdrawal_id: bitsoWithdrawalId,
      });
    } catch (error) {
      console.error('envío USDC a Bridge falló:', salida.id, error.cuerpo ?? error);
      await db.liberarSalidaUs(salida.id, { error: error.message, cuerpo: error.cuerpo ?? null });
    }
  }
}

// Modo 'bitso_api': Bitso no devuelve el tx hash al crear el retiro. Se consulta después y se guarda
// en tx_hash_bridge para que el webhook de Bridge pueda cerrar el lote como 'completado_ach'.
export async function sincronizarRetirosBitso() {
  for (const salida of await db.salidasUsSinTxHash(25)) {
    try {
      const retiro = await juno.obtenerRetiroUsdcExterno(salida.bitsoWithdrawalId);
      if (retiro.txHash) {
        await db.guardarTxHashSalidaUs(salida.id, retiro.txHash);
      } else if (['failed', 'cancelled'].includes(String(retiro.estado).toLowerCase())) {
        // No se reintenta automáticamente para no arriesgar un doble envío; requiere revisión manual.
        await db.actualizarSalidaUs(salida.id, {
          estado: 'fallido',
          detalle: { error: `Retiro de Bitso ${retiro.estado}`, bitsoWithdrawalId: salida.bitsoWithdrawalId },
        });
      }
    } catch (error) {
      console.error('consulta de retiro Bitso falló:', salida.id, error.cuerpo ?? error);
    }
  }
}
