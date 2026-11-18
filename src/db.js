import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

const q = (texto, params) => pool.query(texto, params);

// ───────────── Perfil y onboarding ─────────────

const aPerfil = (r) =>
  r && {
    userId: r.user_id,
    wallet: r.wallet,
    estado: r.estado_onboarding,
    clabe: r.clabe,
    junoTag: r.juno_tag,
    walletRegistrada: r.wallet_registrada_en_juno,
  };

export async function obtenerPerfil(userId) {
  const { rows } = await q('SELECT * FROM usuarios_perfil WHERE user_id = $1', [userId]);
  return aPerfil(rows[0]);
}

export async function obtenerPerfilPorClabe(clabe) {
  const { rows } = await q('SELECT * FROM usuarios_perfil WHERE clabe = $1', [clabe]);
  return aPerfil(rows[0]);
}

export async function tomarOnboarding(userId, wallet) {
  await q(
    `INSERT INTO usuarios_perfil (user_id, wallet) VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, wallet]
  );
  const { rows } = await q(
    `UPDATE usuarios_perfil SET estado_onboarding = 'en_proceso', actualizado_en = now()
     WHERE user_id = $1
       AND (estado_onboarding = 'pendiente'
            OR (estado_onboarding = 'en_proceso' AND actualizado_en < now() - interval '2 minutes'))
     RETURNING *`,
    [userId]
  );
  if (rows[0]) return { tomado: true, perfil: aPerfil(rows[0]) };
  return { tomado: false, perfil: await obtenerPerfil(userId) };
}

export const guardarClabe = (userId, clabe, tag) =>
  q('UPDATE usuarios_perfil SET clabe = $2, juno_tag = $3, actualizado_en = now() WHERE user_id = $1', [
    userId,
    clabe,
    tag,
  ]);

export const marcarWalletRegistrada = (userId) =>
  q(
    'UPDATE usuarios_perfil SET wallet_registrada_en_juno = TRUE, actualizado_en = now() WHERE user_id = $1',
    [userId]
  );

export const completarOnboarding = (userId) =>
  q("UPDATE usuarios_perfil SET estado_onboarding = 'completo', actualizado_en = now() WHERE user_id = $1", [
    userId,
  ]);

export const liberarOnboarding = (userId) =>
  q(
    `UPDATE usuarios_perfil SET estado_onboarding = 'pendiente', actualizado_en = now()
     WHERE user_id = $1 AND estado_onboarding = 'en_proceso'`,
    [userId]
  );

export async function obtenerCuentaBancaria(userId) {
  const { rows } = await q('SELECT juno_bank_account_id FROM cuentas_bancarias WHERE user_id = $1', [userId]);
  return rows[0] && { junoBankAccountId: rows[0].juno_bank_account_id };
}

// ───────────── Catálogo y órdenes ─────────────

export async function obtenerItem(itemId) {
  const { rows } = await q('SELECT monto, creador_wallet FROM items WHERE item_id = $1', [itemId]);
  return rows[0] && { monto: BigInt(rows[0].monto), creadorWallet: rows[0].creador_wallet };
}

export const guardarOrden = (o) =>
  q(
    `INSERT INTO ordenes (order_id, user_id, item_id, monto, comprador, creador, expira_en)
     VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7))`,
    [o.orderId, o.userId, o.itemId, o.monto.toString(), o.comprador, o.creador, o.expiraEn.toString()]
  );

export async function obtenerOrdenDeUsuario(orderId, userId) {
  if (typeof orderId !== 'string' || !/^[0-9a-f]{32}$/.test(orderId)) return null;
  const { rows } = await q('SELECT * FROM ordenes WHERE order_id = $1 AND user_id = $2', [orderId, userId]);
  return rows[0] && { orderId: rows[0].order_id, estado: rows[0].estado, txHash: rows[0].tx_hash };
}

export async function marcarOrdenPagada(orderId, txHash) {
  const { rowCount } = await q(
    `UPDATE ordenes SET estado = 'pagada', tx_hash = $2, actualizado_en = now()
     WHERE order_id = $1 AND estado = 'creada'`,
    [orderId, txHash]
  );
  return rowCount === 1;
}

export const marcarOrdenCancelada = (orderId) =>
  q(
    `UPDATE ordenes SET estado = 'cancelada', actualizado_en = now()
     WHERE order_id = $1 AND estado = 'creada'`,
    [orderId]
  );

export async function ordenesPendientesAntiguas(segundos = 60) {
  const { rows } = await q(
    `SELECT order_id, expira_en FROM ordenes
     WHERE estado = 'creada' AND creado_en < now() - make_interval(secs => $1)
     ORDER BY creado_en LIMIT 100`,
    [segundos]
  );
  return rows.map((r) => ({ orderId: r.order_id, expiraEn: r.expira_en }));
}

// ───────────── Eventos de Juno ─────────────

export async function registrarEventoJuno({ id, tipo, estado, payload, creadoEn, actualizadoEn }) {
  const { rowCount } = await q(
    `INSERT INTO juno_transacciones (id, tipo, estado, payload, creado_en, actualizado_en)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE
       SET tipo = EXCLUDED.tipo, estado = EXCLUDED.estado, payload = EXCLUDED.payload,
           actualizado_en = EXCLUDED.actualizado_en
       WHERE juno_transacciones.actualizado_en < EXCLUDED.actualizado_en`,
    [id, tipo, estado, JSON.stringify(payload), creadoEn, actualizadoEn]
  );
  return rowCount === 1;
}

async function estadoFinalGuardado(junoId) {
  const { rows } = await q(
    `SELECT estado FROM juno_transacciones WHERE id = $1 AND estado IN ('COMPLETE', 'FAILED')`,
    [junoId]
  );
  return rows[0]?.estado ?? null;
}

// ───────────── Depósitos SPEI -> wallet ─────────────

export async function registrarDeposito({ junoTxId, userId, clabe, monto, idemKey }) {
  const { rowCount } = await q(
    `INSERT INTO depositos (juno_tx_id, user_id, clabe, monto, estado, idem_key_retiro)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (juno_tx_id) DO NOTHING`,
    [junoTxId, userId, clabe, monto.toString(), userId ? 'recibido' : 'huerfano', idemKey]
  );
  return rowCount === 1;
}

export async function reclamarDeposito() {
  const { rows } = await q(
    `UPDATE depositos d
        SET estado = 'retirando', intentos = d.intentos + 1, actualizado_en = now()
      WHERE d.juno_tx_id = (
        SELECT d2.juno_tx_id FROM depositos d2
          JOIN usuarios_perfil p ON p.user_id = d2.user_id
         WHERE d2.estado = 'recibido' AND p.wallet_registrada_en_juno
         ORDER BY d2.creado_en LIMIT 1
         FOR UPDATE OF d2 SKIP LOCKED)
      RETURNING d.juno_tx_id, d.user_id, d.monto, d.idem_key_retiro`
  );
  const r = rows[0];
  return r && { junoTxId: r.juno_tx_id, userId: r.user_id, monto: BigInt(r.monto), idemKey: r.idem_key_retiro };
}

export async function marcarDepositoEnviado(junoTxId, junoRetiroId) {
  await q('UPDATE depositos SET juno_retiro_id = $2, actualizado_en = now() WHERE juno_tx_id = $1', [
    junoTxId,
    junoRetiroId,
  ]);
  const final = junoRetiroId && (await estadoFinalGuardado(junoRetiroId));
  if (final) await resolverRetiroDeposito(junoRetiroId, final === 'COMPLETE');
}

export const liberarDeposito = (junoTxId) =>
  q(
    `UPDATE depositos
        SET estado = CASE WHEN intentos >= 5 THEN 'fallido' ELSE 'recibido' END, actualizado_en = now()
      WHERE juno_tx_id = $1 AND estado = 'retirando'`,
    [junoTxId]
  );

export const resolverRetiroDeposito = (junoRetiroId, ok) =>
  q(
    `UPDATE depositos SET estado = $2, actualizado_en = now()
     WHERE juno_retiro_id = $1 AND estado = 'retirando'`,
    [junoRetiroId, ok ? 'en_wallet' : 'fallido']
  );

// ───────────── Ruta A: retiros a México ─────────────

export async function crearRetiroMx({ userId, monto, walletOrigen, idemKey }) {
  try {
    const { rows } = await q(
      `INSERT INTO retiros_mx (user_id, monto, wallet_origen, estado, idem_key_redencion)
       VALUES ($1, $2, $3, 'esperando_deposito', $4) RETURNING id`,
      [userId, monto.toString(), walletOrigen, idemKey]
    );
    return rows[0].id;
  } catch (error) {
    if (error.code === '23505') return null;
    throw error;
  }
}

export async function obtenerRetiroMx(id, userId) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return null;
  }
  const { rows } = await q('SELECT id, monto, estado FROM retiros_mx WHERE id = $1 AND user_id = $2', [id, userId]);
  return rows[0] && { id: rows[0].id, monto: BigInt(rows[0].monto), estado: rows[0].estado };
}

export const expirarRetirosMx = () =>
  q(
    `UPDATE retiros_mx SET estado = 'expirado', actualizado_en = now()
     WHERE estado = 'esperando_deposito' AND creado_en < now() - interval '1 hour'`
  );

export async function asignarDepositoCripto({ walletOrigen, monto, junoDepositoId }) {
  const ya = await q('SELECT 1 FROM retiros_mx WHERE juno_deposito_id = $1', [junoDepositoId]);
  if (ya.rowCount) return 'duplicado';
  const { rowCount } = await q(
    `UPDATE retiros_mx SET estado = 'en_juno', juno_deposito_id = $3, actualizado_en = now()
      WHERE id = (SELECT id FROM retiros_mx
                   WHERE estado = 'esperando_deposito' AND wallet_origen = $1 AND monto = $2
                   ORDER BY creado_en LIMIT 1 FOR UPDATE SKIP LOCKED)`,
    [walletOrigen, monto.toString(), junoDepositoId]
  );
  return rowCount === 1 ? 'asignado' : null;
}

export async function reclamarRedencion() {
  const { rows } = await q(
    `UPDATE retiros_mx r
        SET estado = 'redimiendo', intentos = r.intentos + 1, actualizado_en = now()
      WHERE r.id = (SELECT r2.id FROM retiros_mx r2 WHERE r2.estado = 'en_juno'
                     ORDER BY r2.creado_en LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING r.id, r.user_id, r.monto, r.idem_key_redencion`
  );
  const r = rows[0];
  return r && { id: r.id, userId: r.user_id, monto: BigInt(r.monto), idemKey: r.idem_key_redencion };
}

export async function marcarRedencionEnviada(id, junoRedencionId) {
  await q('UPDATE retiros_mx SET juno_redencion_id = $2, actualizado_en = now() WHERE id = $1', [
    id,
    junoRedencionId,
  ]);
  const final = junoRedencionId && (await estadoFinalGuardado(junoRedencionId));
  if (final) await resolverRedencion(junoRedencionId, final === 'COMPLETE');
}

export const liberarRedencion = (id) =>
  q(
    `UPDATE retiros_mx
        SET estado = CASE WHEN intentos >= 5 THEN 'fallido' ELSE 'en_juno' END, actualizado_en = now()
      WHERE id = $1 AND estado = 'redimiendo'`,
    [id]
  );

export const resolverRedencion = (junoRedencionId, ok) =>
  q(
    `UPDATE retiros_mx SET estado = $2, actualizado_en = now()
     WHERE juno_redencion_id = $1 AND estado = 'redimiendo'`,
    [junoRedencionId, ok ? 'completado' : 'fallido']
  );

export async function recuperarAtascados() {
  await q(
    `UPDATE depositos SET estado = 'recibido', actualizado_en = now()
     WHERE estado = 'retirando' AND juno_retiro_id IS NULL AND actualizado_en < now() - interval '5 minutes'`
  );
  await q(
    `UPDATE retiros_mx SET estado = 'en_juno', actualizado_en = now()
     WHERE estado = 'redimiendo' AND juno_redencion_id IS NULL AND actualizado_en < now() - interval '5 minutes'`
  );
  await q(
    `UPDATE salidas_us SET estado = 'convertido', actualizado_en = now()
     WHERE estado = 'enviando_bridge'
       AND bitso_withdrawal_id IS NULL
       AND tx_hash_bridge IS NULL
       AND actualizado_en < now() - interval '5 minutes'`
  );
}

// ───────────── Ruta B: Tesorería EE. UU. (MXNB -> USDC -> Bridge) ─────────────

export const registrarSalidaUs = ({ id, montoMxnb }) =>
  q("INSERT INTO salidas_us (id, monto_mxnb, estado) VALUES ($1, $2, 'cotizando')", [id, montoMxnb.toString()]);

export async function actualizarSalidaUs(id, campos) {
  const permitidos = [
    'estado',
    'monto_usdc',
    'juno_quote_id',
    'juno_conversion_id',
    'bitso_withdrawal_id',
    'tx_hash_bridge',
    'detalle',
  ];
  const claves = Object.keys(campos).filter((k) => permitidos.includes(k));
  if (!claves.length) return;
  const sets = claves.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const valores = claves.map((k) =>
    k === 'detalle'
      ? JSON.stringify(campos[k])
      : k === 'monto_usdc'
        ? campos[k] == null
          ? null
          : campos[k].toString()
        : campos[k]
  );
  await q(`UPDATE salidas_us SET ${sets}, actualizado_en = now() WHERE id = $1`, [id, ...valores]);
}

export const resolverConversion = (junoConversionId, ok, montoUsdc = null) =>
  q(
    `UPDATE salidas_us
        SET estado = $2,
            monto_usdc = COALESCE($3, monto_usdc),
            actualizado_en = now()
      WHERE juno_conversion_id = $1 AND estado = 'convirtiendo'`,
    [junoConversionId, ok ? 'convertido' : 'fallido', montoUsdc ? montoUsdc.toString() : null]
  );

// Toma una conversión completada lista para enviarse a la liquidation_address de Bridge
export async function reclamarSalidaUs() {
  const { rows } = await q(
    `UPDATE salidas_us s
        SET estado = 'enviando_bridge', intentos = s.intentos + 1, actualizado_en = now()
      WHERE s.id = (
        SELECT s2.id FROM salidas_us s2
         WHERE s2.estado = 'convertido' AND s2.monto_usdc IS NOT NULL AND s2.monto_usdc > 0
         ORDER BY s2.creado_en LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING s.id, s.monto_mxnb, s.monto_usdc`
  );
  const r = rows[0];
  return r && { id: r.id, montoMxnb: BigInt(r.monto_mxnb), montoUsdc: BigInt(r.monto_usdc) };
}

export const liberarSalidaUs = (id, detalleError = null) =>
  q(
    `UPDATE salidas_us
        SET estado = CASE WHEN intentos >= 5 THEN 'fallido' ELSE 'convertido' END,
            detalle = COALESCE($2::jsonb, detalle),
            actualizado_en = now()
      WHERE id = $1 AND estado = 'enviando_bridge'`,
    [id, detalleError ? JSON.stringify(detalleError) : null]
  );

export async function listarSalidasUs(limite = 20) {
  const { rows } = await q(
    `SELECT id, monto_mxnb, monto_usdc, estado, juno_conversion_id, bitso_withdrawal_id, tx_hash_bridge, creado_en, actualizado_en
       FROM salidas_us
      ORDER BY creado_en DESC LIMIT $1`,
    [limite]
  );
  return rows;
}

// ───────────── Bridge ─────────────

export async function obtenerBridgeCuenta() {
  const { rows } = await q('SELECT * FROM bridge_cuenta WHERE id = 1');
  const r = rows[0];
  return (
    r && {
      customerId: r.customer_id,
      externalAccountId: r.external_account_id,
      liquidationAddressId: r.liquidation_address_id,
      liquidationAddress: r.liquidation_address,
      chain: r.chain,
    }
  );
}

export const guardarBridgeCuenta = (c) =>
  q(
    `INSERT INTO bridge_cuenta (customer_id, external_account_id, liquidation_address_id, liquidation_address, chain)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
    [c.customerId, c.externalAccountId, c.liquidationAddressId, c.liquidationAddress, c.chain]
  );

export async function registrarEventoBridge({ eventId, tipo, payload }) {
  if (!eventId) return false;
  const { rowCount } = await q(
    `INSERT INTO bridge_eventos (event_id, tipo, payload) VALUES ($1, $2, $3)
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId, tipo, JSON.stringify(payload)]
  );
  return rowCount === 1;
}

export async function completarSalidaUsPorBridge(txHash) {
  if (!txHash) return false;
  const { rowCount } = await q(
    `UPDATE salidas_us
        SET estado = 'completado_ach', actualizado_en = now()
      WHERE LOWER(tx_hash_bridge) = LOWER($1) AND estado = 'enviado_bridge'`,
    [txHash]
  );
  return rowCount === 1;
}

// Lotes enviados vía Bitso cuyo tx hash en Arbitrum aún no se conoce
export async function salidasUsSinTxHash(limite = 25) {
  const { rows } = await q(
    `SELECT id, bitso_withdrawal_id FROM salidas_us
      WHERE estado = 'enviado_bridge' AND tx_hash_bridge IS NULL AND bitso_withdrawal_id IS NOT NULL
      ORDER BY creado_en LIMIT $1`,
    [limite]
  );
  return rows.map((r) => ({ id: r.id, bitsoWithdrawalId: r.bitso_withdrawal_id }));
}

// Guarda el tx hash y, si Bridge ya notificó la liquidación antes de conocerlo, cierra el lote
export async function guardarTxHashSalidaUs(id, txHash) {
  await q(
    `UPDATE salidas_us SET tx_hash_bridge = $2, actualizado_en = now()
      WHERE id = $1 AND tx_hash_bridge IS NULL`,
    [id, txHash]
  );
  const { rowCount } = await q(
    `SELECT 1 FROM bridge_eventos
      WHERE LOWER(COALESCE(payload #>> '{data,source_deposit_instructions,tx_hash}',
                           payload #>> '{event_object,deposit_tx_hash}',
                           payload #>> '{data,deposit_tx_hash}')) = LOWER($1)
        AND LOWER(COALESCE(payload #>> '{data,state}', payload #>> '{event_object,state}'))
            IN ('payment_processed', 'completed')
      LIMIT 1`,
    [txHash]
  );
  if (rowCount) await completarSalidaUsPorBridge(txHash);
}
