// Firma una orden de prueba con la clave del operador, para pagarla a mano (p. ej. desde Remix)
// sin levantar el backend. Usa exactamente la misma firma EIP-712 que el backend (src/firmas.js).
//
// Uso (desde la raíz del repositorio, con OPERADOR_PRIVATE_KEY en .env o en el entorno):
//   node --env-file=.env scripts/firmar-orden.mjs <contrato> <comprador> <creador> <montoMXNB> [minutosDeVigencia]
//
// Ejemplo (100 MXNB, válida 30 minutos):
//   node --env-file=.env scripts/firmar-orden.mjs 0xFFcB…Cf46 0x6F1A…cEE2 0x70C5…bA66 100 30
//
// La clave nunca se imprime. Por defecto usa Arbitrum Sepolia; la comisión se lee del contrato.
import crypto from 'node:crypto';
import { createPublicClient, getAddress, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, arbitrumSepolia } from 'viem/chains';
import { firmarOrden, hashOrden } from '../src/firmas.js';
import { aMicro } from '../src/unidades.js';

const [contratoArg, compradorArg, creadorArg, montoArg, minutosArg = '30'] = process.argv.slice(2);
if (!contratoArg || !compradorArg || !creadorArg || !montoArg) {
  console.error('Uso: node --env-file=.env scripts/firmar-orden.mjs <contrato> <comprador> <creador> <montoMXNB> [minutos]');
  process.exit(1);
}
if (!process.env.OPERADOR_PRIVATE_KEY) {
  console.error('Falta OPERADOR_PRIVATE_KEY (en .env o en el entorno).');
  process.exit(1);
}

const red = process.env.ARBITRUM_TESTNET === '0' ? arbitrum : arbitrumSepolia;
const rpc = process.env.ARBITRUM_RPC_URL || red.rpcUrls.default.http[0];
const contrato = getAddress(contratoArg.toLowerCase());
const operador = privateKeyToAccount(process.env.OPERADOR_PRIVATE_KEY);

const cliente = createPublicClient({ chain: red, transport: http(rpc) });
const abi = parseAbi(['function operador() view returns (address)', 'function comisionBps() view returns (uint16)']);
const [operadorContrato, comisionBps] = await Promise.all([
  cliente.readContract({ address: contrato, abi, functionName: 'operador' }),
  cliente.readContract({ address: contrato, abi, functionName: 'comisionBps' }),
]);
if (getAddress(operadorContrato) !== operador.address) {
  console.error(`La clave es de ${operador.address}, pero el operador del contrato es ${operadorContrato}.`);
  console.error('El contrato rechazaría la firma (FirmaInvalida). Usa la clave del operador correcto.');
  process.exit(1);
}

const orden = {
  orderId: `0x${crypto.randomBytes(16).toString('hex')}`,
  comprador: getAddress(compradorArg.toLowerCase()),
  creador: getAddress(creadorArg.toLowerCase()),
  monto: aMicro(montoArg),
  comisionBps,
  expiraEn: BigInt(Math.floor(Date.now() / 1000) + Number(minutosArg) * 60),
};
const params = { chainId: red.id, contrato, orden };
const firma = await firmarOrden(operador, params);

const plataforma = (orden.monto * BigInt(comisionBps)) / 10_000n;
console.log(`Red: ${red.name} (${red.id}) · contrato ${contrato}`);
console.log(`Operador: ${operador.address} ✔ coincide con el contrato`);
console.log(`Caduca: ${new Date(Number(orden.expiraEn) * 1000).toLocaleString()}`);
console.log(`Reparto esperado: creador ${orden.monto - plataforma} · tesorería ${plataforma} (unidades de 6 decimales)`);
console.log('\n1) approve en MXNB (spender, amount):');
console.log(`   ${contrato}, ${orden.monto}`);
console.log('\n2) pagarOrden en el contrato. Pega cada valor en su campo, desde la cuenta del comprador:');
console.log(`   orden: ["${orden.orderId}","${orden.comprador}","${orden.creador}","${orden.monto}","${orden.comisionBps}","${orden.expiraEn}"]`);
console.log(`   firma: ${firma}`);
console.log(`\n   (digest EIP-712: ${hashOrden(params)})`);
