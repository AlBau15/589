// Acceso a Arbitrum: contrato de pagos, token MXNB y USDC nativo (Ruta B)
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, arbitrumSepolia } from 'viem/chains';
import { firmarOrden } from './firmas.js';

const testnet = process.env.ARBITRUM_TESTNET === '1';
const red = testnet ? arbitrumSepolia : arbitrum;
const norm = (a) => getAddress(a.toLowerCase());

// Proxy oficial de MXNB (6 decimales)
export const MXNB = norm(
  process.env.MXNB_ADDRESS ??
    (testnet ? '0x82B9e52b26A2954E113F94Ff26647754d5a4247D' : '0xF197FFC28c23E0309B5559e7a166f2c6164C80aA')
);

// USDC nativo de Circle en Arbitrum One / Arbitrum Sepolia (6 decimales)
export const USDC = norm(
  process.env.USDC_ADDRESS ??
    (testnet ? '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' : '0xaf88d065e77c8cC2239327C5EDb3A432268e5831')
);

export const CONTRATO = norm(process.env.CONTRATO_PAGOS);

const transporte = http(process.env.ARBITRUM_RPC_URL);
export const publicClient = createPublicClient({ chain: red, transport: transporte });

// El operador solo firma órdenes fuera de la cadena (EIP-712): no envía transacciones ni necesita ETH.
const operador = privateKeyToAccount(process.env.OPERADOR_PRIVATE_KEY);

const abiPagos = parseAbi([
  'struct Orden { bytes16 orderId; address comprador; address creador; uint128 monto; uint16 comisionBps; uint64 expiraEn; }',
  'function pagarOrden(Orden orden, bytes firma)',
  'function estados(bytes16 orderId) view returns (uint8)',
  'function comisionBps() view returns (uint16)',
  'event CompraConfirmada(bytes16 indexed orderId, address indexed comprador, address indexed creador, uint256 montoTotal, uint256 montoCreador, uint256 montoPlataforma)',
]);

const ESTADO = { PENDIENTE: 0, PAGADA: 1, CANCELADA: 2 };

const abiErc20 = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

const aBytes16 = (orderIdHex32) => `0x${orderIdHex32}`;

// Firma la orden con la comisión vigente del contrato. No envía ninguna transacción.
export async function firmarOrdenPago({ orderId, comprador, creador, monto, expiraEn }) {
  const comisionBps = await publicClient.readContract({ address: CONTRATO, abi: abiPagos, functionName: 'comisionBps' });
  const orden = { orderId: aBytes16(orderId), comprador, creador, monto, comisionBps, expiraEn };
  const firma = await firmarOrden(operador, { chainId: red.id, contrato: CONTRATO, orden });
  return { orden, firma };
}

export const saldoMxnb = (direccion) =>
  publicClient.readContract({ address: MXNB, abi: abiErc20, functionName: 'balanceOf', args: [direccion] });

export const saldoUsdc = (direccion) =>
  publicClient.readContract({ address: USDC, abi: abiErc20, functionName: 'balanceOf', args: [direccion] });

// Ruta B, modo 'onchain_tesoreria'. El envío se separa en tres pasos para no enviar nunca dos veces:
//   1) prepararEnvioUsdcTesoreria: validaciones sin mover dinero (se puede reintentar sin riesgo);
//   2) enviarUsdcTesoreria: firma y emite la transferencia y devuelve el hash de inmediato, para guardarlo
//      antes de esperar la confirmación;
//   3) transaccionExitosa: espera el recibo.
function clienteTesoreria() {
  if (!process.env.TESORERIA_USDC_PRIVATE_KEY) {
    throw new Error('Falta configurar TESORERIA_USDC_PRIVATE_KEY para transferir USDC a Bridge');
  }
  const cuenta = privateKeyToAccount(process.env.TESORERIA_USDC_PRIVATE_KEY);
  return createWalletClient({ account: cuenta, chain: red, transport: transporte });
}

export async function prepararEnvioUsdcTesoreria({ montoMicro }) {
  const cliente = clienteTesoreria();
  const saldoActual = await saldoUsdc(cliente.account.address);
  if (saldoActual < montoMicro) {
    throw new Error(`Saldo USDC insuficiente en tesorería (${saldoActual} < ${montoMicro})`);
  }
}

export function enviarUsdcTesoreria({ destino, montoMicro }) {
  return clienteTesoreria().writeContract({
    address: USDC,
    abi: abiErc20,
    functionName: 'transfer',
    args: [norm(destino), montoMicro],
  });
}

export async function transaccionExitosa(hash) {
  const recibo = await publicClient.waitForTransactionReceipt({ hash });
  return recibo.status === 'success';
}

export async function estadoOrden(orderId) {
  const estado = await publicClient.readContract({
    address: CONTRATO,
    abi: abiPagos,
    functionName: 'estados',
    args: [aBytes16(orderId)],
  });
  return { pagada: estado === ESTADO.PAGADA, cancelada: estado === ESTADO.CANCELADA };
}

// Llamadas que el cliente envía en un solo UserOperation: approve del monto exacto + pago de la orden firmada
export function callsPago({ orden, firma }) {
  return [
    {
      to: MXNB,
      data: encodeFunctionData({ abi: abiErc20, functionName: 'approve', args: [CONTRATO, orden.monto] }),
    },
    {
      to: CONTRATO,
      data: encodeFunctionData({ abi: abiPagos, functionName: 'pagarOrden', args: [orden, firma] }),
    },
  ];
}

export function vigilarCompras(alPagar) {
  return publicClient.watchContractEvent({
    address: CONTRATO,
    abi: abiPagos,
    eventName: 'CompraConfirmada',
    onLogs: async (logs) => {
      for (const log of logs) {
        await alPagar({ orderId: log.args.orderId.slice(2), txHash: log.transactionHash }).catch(console.error);
      }
    },
    onError: console.error,
  });
}
