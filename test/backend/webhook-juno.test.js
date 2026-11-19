// Webhook de Juno de punta a punta, con Juno y la base de datos simulados.
import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';

process.env.JUNO_ENTORNO = 'stage';
const IP_JUNO = '3.129.233.228';
const ID = '7f1c2a9e-1b2c-4d3e-8f90-123456789abc';
const CLABE = '710969000000000001';

class JunoError extends Error {
  constructor(m, { status } = {}) {
    super(m);
    this.status = status;
  }
}
const juno = { respuesta: null };
const llamadas = { depositos: [] };

mock.module('../../src/juno.js', {
  namedExports: {
    JunoError,
    obtenerTransaccion: async () => {
      if (juno.respuesta instanceof Error) throw juno.respuesta;
      return juno.respuesta;
    },
  },
});
mock.module('../../src/db.js', {
  namedExports: {
    registrarEventoJuno: async () => true,
    obtenerPerfilPorClabe: async (clabe) => (clabe === CLABE ? { userId: 'usuario-1' } : null),
    registrarDeposito: async (d) => {
      llamadas.depositos.push(d);
      return true;
    },
    asignarDepositoCripto: async () => 'asignado',
    resolverRetiroDeposito: async () => {},
    resolverRedencion: async () => {},
    resolverConversion: async () => {},
    registrarEventoBridge: async () => true,
    completarSalidaUsPorBridge: async () => true,
  },
});
mock.module('../../src/bridge.js', { namedExports: { verificarWebhookBridge: () => false } });

let servidor;
let url;
before(async () => {
  const { default: express } = await import('express');
  const { webhooks } = await import('../../src/webhooks.js');
  const app = express();
  app.set('trust proxy', 1); // simula un balanceador delante que añade X-Forwarded-For
  app.use(webhooks);
  await new Promise((r) => (servidor = app.listen(0, r)));
  url = `http://127.0.0.1:${servidor.address().port}/webhooks/juno`;
});
after(() => servidor.close());
beforeEach(() => {
  llamadas.depositos = [];
  juno.respuesta = null;
  mock.method(console, 'warn', () => {});
  mock.method(console, 'error', () => {});
});

const enviar = (payload) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': IP_JUNO },
    body: JSON.stringify({ event: 'TRANSACTION', payload }),
  });

const webhookEmision = (amount, clabe = CLABE) => ({
  id: ID,
  type: 'ISSUANCE',
  status: 'COMPLETE',
  issuance: { method: 'SPEI', amount, deposit_receiver_clabe: clabe },
});

test('un webhook falso (Juno no conoce la transacción) no registra ningún depósito', async () => {
  juno.respuesta = new JunoError('not found', { status: 404 });
  const r = await enviar(webhookEmision('100000'));
  assert.equal(r.status, 404);
  assert.equal(llamadas.depositos.length, 0);
});

test('el monto y la CLABE salen de la API de Juno, no del webhook', async () => {
  juno.respuesta = {
    id: ID,
    transaction_type: 'ISSUANCE',
    status: 'COMPLETE',
    amount: '150',
    typed_details: { method: 'SPEI', deposit_receiver_clabe: CLABE },
  };
  // El webhook dice 100,000 y otra CLABE; Juno dice 150 a la CLABE del usuario.
  const r = await enviar(webhookEmision('100000', '999999999999999999'));
  assert.equal(r.status, 200);
  assert.equal(llamadas.depositos.length, 1);
  assert.equal(llamadas.depositos[0].monto, 150_000_000n);
  assert.equal(llamadas.depositos[0].clabe, CLABE);
  assert.equal(llamadas.depositos[0].userId, 'usuario-1');
});

test('si Juno dice que la emisión no está completa, no se registra aunque el webhook diga COMPLETE', async () => {
  juno.respuesta = { id: ID, type: 'ISSUANCE', status: 'PENDING', amount: '150', typed_details: { deposit_receiver_clabe: CLABE } };
  const r = await enviar(webhookEmision('150'));
  assert.equal(r.status, 200);
  assert.equal(llamadas.depositos.length, 0);
});

test('si a la respuesta de Juno le falta la CLABE, falla cerrada (500 para que Juno reintente)', async () => {
  juno.respuesta = { id: ID, type: 'ISSUANCE', status: 'COMPLETE', amount: '150' };
  const r = await enviar(webhookEmision('150'));
  assert.equal(r.status, 500);
  assert.equal(llamadas.depositos.length, 0);
});

test('rechaza peticiones de IPs que no son de Juno y ids mal formados', async () => {
  const r1 = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify({ event: 'TRANSACTION', payload: webhookEmision('150') }),
  });
  assert.equal(r1.status, 403);
  const r2 = await enviar({ ...webhookEmision('150'), id: '../../etc' });
  assert.equal(r2.status, 400);
  assert.equal(llamadas.depositos.length, 0);
});
