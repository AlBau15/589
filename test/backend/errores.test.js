import assert from 'node:assert/strict';
import { test } from 'node:test';
import { puedeReintentarse } from '../../src/errores.js';
import { JunoError } from '../../src/juno.js';

const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

test('antes de intentar el envío, cualquier error se puede reintentar', () => {
  assert.equal(puedeReintentarse(new Error('Saldo USDC insuficiente'), { envioIntentado: false }), true);
  assert.equal(puedeReintentarse(timeout, { envioIntentado: false }), true);
});

test('tras intentar el envío, un rechazo explícito 4xx se puede reintentar', () => {
  for (const status of [400, 401, 403, 422, 429]) {
    assert.equal(puedeReintentarse(new JunoError('rechazo', { status }), { envioIntentado: true }), true, status);
  }
});

test('tras intentar el envío, los errores ambiguos van a revisión manual', () => {
  const ambiguos = [
    timeout,
    new Error('fetch failed'),
    new Error('No se pudo guardar en la base de datos'),
    new JunoError('timeout del proveedor', { status: 408 }),
    new JunoError('duplicado', { status: 409 }),
    new JunoError('error interno', { status: 500 }),
    new JunoError('gateway', { status: 502 }),
    new JunoError('sin status'),
  ];
  for (const error of ambiguos) {
    assert.equal(puedeReintentarse(error, { envioIntentado: true }), false, error.message);
  }
});
