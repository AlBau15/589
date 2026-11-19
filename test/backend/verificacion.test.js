import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmarTransaccion, requerido, VerificacionError } from '../../src/verificacion.js';

const ID = '7f1c2a9e-1b2c-4d3e-8f90-123456789abc';

test('rechaza una respuesta cuyo id no coincide con el del webhook', () => {
  assert.throws(
    () => confirmarTransaccion(ID, { id: '00000000-0000-4000-8000-000000000000', type: 'ISSUANCE', status: 'COMPLETE' }),
    VerificacionError
  );
});

test('rechaza una respuesta sin tipo o sin estado', () => {
  assert.throws(() => confirmarTransaccion(ID, { id: ID, status: 'COMPLETE' }), VerificacionError);
  assert.throws(() => confirmarTransaccion(ID, { id: ID, type: 'ISSUANCE' }), VerificacionError);
  assert.throws(() => confirmarTransaccion(ID, null), VerificacionError);
});

test('lee los datos de typed_details', () => {
  const tx = confirmarTransaccion(ID, {
    id: ID,
    transaction_type: 'issuance',
    status: 'complete',
    amount: '1500.50',
    typed_details: { method: 'SPEI', deposit_receiver_clabe: '710969000000000001' },
  });
  assert.equal(tx.tipo, 'ISSUANCE');
  assert.equal(tx.estado, 'COMPLETE');
  assert.equal(tx.monto, '1500.50');
  assert.equal(tx.metodo, 'SPEI');
  assert.equal(tx.clabe, '710969000000000001');
});

test('lee los datos con la forma de los webhooks (crypto_deposit)', () => {
  const tx = confirmarTransaccion(ID, {
    id: ID,
    type: 'CRYPTO_DEPOSIT',
    status: 'COMPLETE',
    crypto_deposit: { asset: 'MXNB', amount: '250', crypto_source_address: '0xAbC' },
  });
  assert.equal(tx.activo, 'MXNB');
  assert.equal(tx.monto, '250');
  assert.equal(tx.origenCripto, '0xAbC');
});

test('requerido falla cerrada si falta un dato que decide a quién se paga', () => {
  const tx = confirmarTransaccion(ID, { id: ID, type: 'ISSUANCE', status: 'COMPLETE', amount: '10' });
  assert.equal(requerido(tx, 'monto'), '10');
  assert.throws(() => requerido(tx, 'clabe'), VerificacionError);
});
