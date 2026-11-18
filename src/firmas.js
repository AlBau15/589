// Firma EIP-712 de órdenes de pago. Debe coincidir con ORDEN_TYPEHASH y el dominio de PagoAtomicoMXNB.sol.
import { hashTypedData } from 'viem';

export const TIPOS_ORDEN = {
  Orden: [
    { name: 'orderId', type: 'bytes16' },
    { name: 'comprador', type: 'address' },
    { name: 'creador', type: 'address' },
    { name: 'monto', type: 'uint128' },
    { name: 'comisionBps', type: 'uint16' },
    { name: 'expiraEn', type: 'uint64' },
  ],
};

export const dominioPagos = ({ chainId, contrato }) => ({
  name: 'PagoAtomicoMXNB',
  version: '1',
  chainId,
  verifyingContract: contrato,
});

const datos = ({ chainId, contrato, orden }) => ({
  domain: dominioPagos({ chainId, contrato }),
  types: TIPOS_ORDEN,
  primaryType: 'Orden',
  message: orden,
});

// `cuenta` es una cuenta local de viem (privateKeyToAccount). Devuelve la firma de 65 bytes en hex.
export const firmarOrden = (cuenta, params) => cuenta.signTypedData(datos(params));

// Digest que verifica el contrato (equivale a PagoAtomicoMXNB.hashOrden)
export const hashOrden = (params) => hashTypedData(datos(params));
