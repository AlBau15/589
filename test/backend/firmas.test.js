// Vector de referencia compartido con test/contracts/PagoAtomicoMXNB.t.sol (test_VectorFirmaBackend).
// Si cambia la firma del backend, el contrato dejará de aceptarla: actualiza ambos tests a la vez.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { dominioPagos, firmarOrden, hashOrden, TIPOS_ORDEN } from '../../src/firmas.js';

// Clave pública de pruebas (anvil #0). NUNCA usarla en producción.
const CLAVE_PRUEBA = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const VECTOR = {
  chainId: 42161,
  contrato: '0x00000000000000000000000000000000c0ffee01',
  orden: {
    orderId: '0x000102030405060708090a0b0c0d0e0f',
    comprador: '0x000000000000000000000000000000000000aaaa',
    creador: '0x000000000000000000000000000000000000bbbb',
    monto: 1_000_000_000n,
    comisionBps: 500,
    expiraEn: 2_000_000_000n,
  },
};
const DIGEST = '0x1e198ee1b2200e43b5382e95dea448732eeaf78d7a9f9b180b1f756007d71464';
const FIRMA =
  '0x617f747b01144290ee99c8b636a4b9781be59e72b1492d7d1449d587656ec05c0bd2e32802e241e8cfc3d88b806456b0b9f4bb954ee0b70c8f656916991adbe41b';

test('el digest EIP-712 coincide con el vector del contrato', () => {
  assert.equal(hashOrden(VECTOR), DIGEST);
});

test('la firma del operador coincide con el vector del contrato', async () => {
  const cuenta = privateKeyToAccount(CLAVE_PRUEBA);
  assert.equal(await firmarOrden(cuenta, VECTOR), FIRMA);
});

test('la firma recupera la dirección del operador', async () => {
  const firmante = await recoverTypedDataAddress({
    domain: dominioPagos(VECTOR),
    types: TIPOS_ORDEN,
    primaryType: 'Orden',
    message: VECTOR.orden,
    signature: FIRMA,
  });
  assert.equal(firmante, privateKeyToAccount(CLAVE_PRUEBA).address);
});

test('cambiar cualquier campo cambia el digest', () => {
  const campos = { monto: 1n, comisionBps: 0, expiraEn: 1n, creador: '0x000000000000000000000000000000000000cccc' };
  for (const [campo, valor] of Object.entries(campos)) {
    const alterado = { ...VECTOR, orden: { ...VECTOR.orden, [campo]: valor } };
    assert.notEqual(hashOrden(alterado), DIGEST, campo);
  }
  assert.notEqual(hashOrden({ ...VECTOR, chainId: 421614 }), DIGEST, 'chainId');
});
