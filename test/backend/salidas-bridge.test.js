// Envío de USDC a Bridge (Ruta B) con la cadena, Bitso y la base de datos simulados.
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

class JunoError extends Error {
  constructor(m, { status } = {}) {
    super(m);
    this.status = status;
  }
}

const estado = {};
const sim = {};
const reiniciar = () => {
  Object.assign(estado, { cola: [], actualizaciones: [], liberadas: [], revision: [], envios: 0 });
  Object.assign(sim, { prepararFalla: null, enviarFalla: null, guardarFalla: null, reciboOk: true, reciboFalla: null, bitsoFalla: null });
};
reiniciar();

const salida = { id: '11111111-2222-4333-8444-555555555555', montoMxnb: 25_000_000_000n, montoUsdc: 1_300_000_000n };

mock.module('../../src/bridge.js', {
  namedExports: { asegurarDireccionLiquidacion: async () => ({ liquidationAddress: '0x000000000000000000000000000000000000b1d6', chain: 'arbitrum' }) },
});
mock.module('../../src/chain.js', {
  namedExports: {
    prepararEnvioUsdcTesoreria: async () => {
      if (sim.prepararFalla) throw sim.prepararFalla;
    },
    enviarUsdcTesoreria: async () => {
      estado.envios++;
      if (sim.enviarFalla) throw sim.enviarFalla;
      return '0xhash';
    },
    transaccionExitosa: async () => {
      if (sim.reciboFalla) throw sim.reciboFalla;
      return sim.reciboOk;
    },
  },
});
mock.module('../../src/juno.js', {
  namedExports: {
    JunoError,
    retirarUsdcExterno: async () => {
      estado.envios++;
      if (sim.bitsoFalla) throw sim.bitsoFalla;
      return 'wid-1';
    },
  },
});
mock.module('../../src/db.js', {
  namedExports: {
    reclamarSalidaUs: async () => estado.cola.shift() ?? null,
    actualizarSalidaUs: async (id, campos) => {
      if (sim.guardarFalla) throw sim.guardarFalla;
      estado.actualizaciones.push(campos);
    },
    liberarSalidaUs: async (id) => estado.liberadas.push(id),
    marcarSalidaUsRevision: async (id) => estado.revision.push(id),
  },
});

const { procesarSalidasUs } = await import('../../src/salidas.js');

beforeEach(() => {
  reiniciar();
  estado.cola.push({ ...salida });
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
});

const enModo = (modo) => (process.env.RUTA_B_MODO_RETIRO = modo);

test('on-chain: guarda el hash y marca enviado_bridge', async () => {
  enModo('onchain_tesoreria');
  await procesarSalidasUs();
  assert.equal(estado.envios, 1);
  assert.deepEqual(estado.actualizaciones, [{ estado: 'enviado_bridge', tx_hash_bridge: '0xhash' }]);
  assert.equal(estado.liberadas.length + estado.revision.length, 0);
});

test('on-chain: si falla la espera del recibo NO se reintenta (el dinero ya salió)', async () => {
  enModo('onchain_tesoreria');
  sim.reciboFalla = new Error('RPC caída');
  await procesarSalidasUs();
  assert.equal(estado.envios, 1);
  assert.deepEqual(estado.actualizaciones, [{ estado: 'enviado_bridge', tx_hash_bridge: '0xhash' }]);
  assert.equal(estado.liberadas.length, 0, 'no debe volver a la cola');
});

test('on-chain: si la transacción se revierte, va a revisión manual', async () => {
  enModo('onchain_tesoreria');
  sim.reciboOk = false;
  await procesarSalidasUs();
  assert.equal(estado.actualizaciones.at(-1).estado, 'revision_manual');
  assert.equal(estado.liberadas.length, 0);
});

test('on-chain: si falla el envío o el guardado del hash, va a revisión manual, no se reintenta', async () => {
  enModo('onchain_tesoreria');
  sim.enviarFalla = new Error('timeout de la RPC');
  await procesarSalidasUs();
  assert.deepEqual([estado.liberadas.length, estado.revision.length], [0, 1]);

  reiniciar();
  estado.cola.push({ ...salida });
  sim.guardarFalla = new Error('base de datos caída');
  await procesarSalidasUs();
  assert.equal(estado.envios, 1);
  assert.deepEqual([estado.liberadas.length, estado.revision.length], [0, 1]);
});

test('on-chain: un fallo ANTES de enviar (saldo insuficiente) sí se reintenta', async () => {
  enModo('onchain_tesoreria');
  sim.prepararFalla = new Error('Saldo USDC insuficiente');
  await procesarSalidasUs();
  assert.equal(estado.envios, 0);
  assert.deepEqual([estado.liberadas.length, estado.revision.length], [1, 0]);
});

test('Bitso: timeout o 5xx van a revisión manual; un 4xx explícito se reintenta', async () => {
  enModo('bitso_api');
  sim.bitsoFalla = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  await procesarSalidasUs();
  assert.deepEqual([estado.liberadas.length, estado.revision.length], [0, 1]);

  reiniciar();
  estado.cola.push({ ...salida });
  sim.bitsoFalla = new JunoError('error interno', { status: 502 });
  await procesarSalidasUs();
  assert.deepEqual([estado.liberadas.length, estado.revision.length], [0, 1]);

  reiniciar();
  estado.cola.push({ ...salida });
  sim.bitsoFalla = new JunoError('saldo insuficiente', { status: 400 });
  await procesarSalidasUs();
  assert.deepEqual([estado.liberadas.length, estado.revision.length], [1, 0]);
});

test('Bitso: éxito guarda el id del retiro', async () => {
  enModo('bitso_api');
  await procesarSalidasUs();
  assert.deepEqual(estado.actualizaciones, [{ estado: 'enviado_bridge', bitso_withdrawal_id: 'wid-1' }]);
});
