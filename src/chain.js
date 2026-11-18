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

const operador = privateKeyToAccount(process.env.OPERADOR_PRIVATE_KEY);
const walletClient = createWalletClient({ account: operador, chain: red, transport: transporte });

const abiPagos = parseAbi([
  'function crearOrden(bytes16 orderId, address comprador, address creador, uint128 monto, uint64 expiraEn)',
  'function pagarOrden(bytes16 orderId)',
  'function ordenes(bytes16 orderId) view returns (address comprador, address creador, uint128 monto, uint16 comisionBps, bool pagada, bool cancelada, uint64 expiraEn)',
  'event CompraConfirmada(bytes16 indexed orderId, address indexed comprador, address indexed creador, uint256 montoTotal, uint256 montoCreador, uint256 montoPlataforma)',
]);

const abiErc20 = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

const aBytes16 = (orderIdHex32) => `0x${orderIdHex32}`;

export async function crearOrdenOnchain({ orderId, comprador, creador, monto, expiraEn }) {
  const hash = await walletClient.writeContract({
    address: CONTRATO,
    abi: abiPagos,
    functionName: 'crearOrden',
    args: [aBytes16(orderId), comprador, creador, monto, expiraEn],
  });
  const recibo = await publicClient.waitForTransactionReceipt({ hash });
  if (recibo.status !== 'success') throw new Error('crearOrden revertida');
  return hash;
}

export const saldoMxnb = (direccion) =>
  publicClient.readContract({ address: MXNB, abi: abiErc20, functionName: 'balanceOf', args: [direccion] });

export const saldoUsdc = (direccion) =>
  publicClient.readContract({ address: USDC, abi: abiErc20, functionName: 'balanceOf', args: [direccion] });

// Envía USDC nativo desde la wallet operativa de tesorería hacia la liquidation_address de Bridge
export async function transferirUsdcTesoreria({ destino, montoMicro }) {
  if (!process.env.TESORERIA_USDC_PRIVATE_KEY) {
    throw new Error('Falta configurar TESORERIA_USDC_PRIVATE_KEY para transferir USDC a Bridge');
  }
  const cuentaTesoreria = privateKeyToAccount(process.env.TESORERIA_USDC_PRIVATE_KEY);
  const tesoreriaClient = createWalletClient({ account: cuentaTesoreria, chain: red, transport: transporte });

  const saldoActual = await saldoUsdc(cuentaTesoreria.address);
  if (saldoActual < montoMicro) {
    throw new Error(`Saldo USDC insuficiente en tesorería (${saldoActual} < ${montoMicro})`);
  }

  const hash = await tesoreriaClient.writeContract({
    address: USDC,
    abi: abiErc20,
    functionName: 'transfer',
    args: [norm(destino), montoMicro],
  });
  const recibo = await publicClient.waitForTransactionReceipt({ hash });
  if (recibo.status !== 'success') throw new Error('Transferencia USDC a Bridge revertida');
  return hash;
}

export async function estadoOrden(orderId) {
  const [comprador, creador, monto, comisionBps, pagada, cancelada, expiraEn] = await publicClient.readContract({
    address: CONTRATO,
    abi: abiPagos,
    functionName: 'ordenes',
    args: [aBytes16(orderId)],
  });
  return { comprador, creador, monto, comisionBps, pagada, cancelada, expiraEn };
}

export function callsPago({ orderId, monto }) {
  return [
    {
      to: MXNB,
      data: encodeFunctionData({ abi: abiErc20, functionName: 'approve', args: [CONTRATO, monto] }),
    },
    {
      to: CONTRATO,
      data: encodeFunctionData({ abi: abiPagos, functionName: 'pagarOrden', args: [aBytes16(orderId)] }),
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
