# Contrato `PagoAtomicoMXNB`

Contrato de pago en MXNB sobre Arbitrum. El backend firma cada orden fuera de la cadena (EIP-712) y el comprador la paga en una sola transacción; el contrato verifica la firma y reparte el monto entre el creador y la tesorería de la plataforma. El contrato nunca retiene fondos.

Código: [`contracts/PagoAtomicoMXNB.sol`](../contracts/PagoAtomicoMXNB.sol) · Tests: [`test/contracts/`](../test/contracts/) · Despliegue: [`script/DesplegarPagoAtomicoMXNB.s.sol`](../script/DesplegarPagoAtomicoMXNB.s.sol)

## Roles

| Rol | Quién | Puede |
|-----|-------|-------|
| **Operador** | El backend (`OPERADOR_PRIVATE_KEY`) | Firmar órdenes fuera de la cadena (no envía transacciones ni necesita ETH) y cancelar órdenes firmadas antes de que se paguen. |
| **Comprador** | La smart wallet fijada en cada orden | Pagar su orden. |
| **Owner** | Idealmente un multisig (Safe) | Cambiar tesorería, operador y comisión; pausar y reanudar; rescatar tokens enviados por error; transferir la administración en dos pasos. |

## Ciclo de una orden

1. El backend arma la orden `{orderId, comprador, creador, monto, comisionBps, expiraEn}` con la comisión vigente del contrato y la firma con la clave del operador ([EIP-712](https://eips.ethereum.org/EIPS/eip-712), dominio `PagoAtomicoMXNB` versión `1`). No hay ninguna transacción.
2. El comprador envía `approve(contrato, monto)` + `pagarOrden(orden, firma)` en una sola UserOperation, cuyo gas cubre el paymaster.
3. El contrato verifica la firma, marca el `orderId` como pagado y transfiere `monto − comisión` al creador y la comisión a la tesorería.

Una orden **no se puede pagar** si:

| Caso | Error |
|------|-------|
| Quien paga no es `orden.comprador` | `CompradorInvalido` |
| `block.timestamp >= orden.expiraEn` | `OrdenExpirada` |
| El `orderId` ya se pagó o se canceló | `OrdenNoPagable` |
| La firma no es del operador actual, o se alteró algún campo | `FirmaInvalida` |
| La comisión del contrato cambió desde que se firmó | `ComisionCambiada` |
| `monto` es 0 o `creador` es la dirección cero | `MontoInvalido` / `DireccionInvalida` |
| El contrato está en pausa | `EnforcedPause` |

## Garantías

- **Firma ligada a este contrato y esta red:** el dominio EIP-712 incluye `chainId` y la dirección del contrato, así que una firma no sirve en otra red ni en otro despliegue.
- **Sin repetición:** cada `orderId` se puede pagar una sola vez.
- **Caducidad:** el backend fija `expiraEn = ahora + ORDEN_VIGENCIA_SEGUNDOS` (900 s por defecto) y marca como cancelada en la base de datos una orden que caducó sin pagarse.
- **Comisión máxima del 30 %** (`COMISION_MAXIMA_BPS = 3000`). La comisión va firmada en la orden y debe coincidir con la vigente al pagar: el creador recibe exactamente el reparto que se le mostró.
- **Rotación del operador:** `setOperador` invalida al instante todas las firmas pendientes del operador anterior.
- **La administración no se puede abandonar:** `renounceOwnership` está deshabilitado. Para cambiar de owner se usa `transferOwnership` y el nuevo owner confirma con `acceptOwnership`.
- **Rescate de tokens:** `rescatarTokens(token, destino, monto)` recupera cualquier token enviado directamente al contrato por error.
- **Sin reentrada ni doble pago:** `nonReentrant`, y la orden se marca como pagada antes de mover fondos.

## Compatibilidad backend ↔ contrato

`src/firmas.js` produce la firma y `hashOrden(orden)` del contrato expone el digest que se verifica. Ambos lados comparten un vector de referencia (clave de pruebas pública, `chainId` 42161, dirección fija):

- `test/backend/firmas.test.js` comprueba que el backend produce exactamente ese digest y esa firma.
- `test_VectorFirmaBackend` en `test/contracts/` comprueba que el contrato acepta esa firma y ejecuta el pago.

Si cambias la estructura de la orden o el dominio, actualiza los dos tests a la vez.

## Desarrollo

Requiere [Foundry](https://getfoundry.sh). Las dependencias (OpenZeppelin v5.6.1 y forge-std) son submódulos de git:

```bash
git submodule update --init   # o clonar con: git clone --recurse-submodules
forge build
forge test -vvv
```

El CI compila el contrato y ejecuta sus tests (job `contrato`), y ejecuta los tests del backend, incluido el de firmas (job `check`), en cada pull request.

## Despliegue

El script lee los parámetros de variables de entorno:

| Variable | Valor |
|----------|-------|
| `MXNB_ADDRESS` | Proxy de MXNB de la red (ver [direcciones](arquitectura.md#direcciones-de-tokens)). |
| `TESORERIA_ADDRESS` | Wallet que recibe la comisión. |
| `OPERADOR_ADDRESS` | Dirección de `OPERADOR_PRIVATE_KEY` del backend (solo firma; no necesita ETH). |
| `OWNER_ADDRESS` | Multisig administrador. |
| `COMISION_BPS` | Comisión en puntos básicos (p. ej. `500` = 5 %; máximo `3000`). |

```bash
# Importa una vez la clave que paga el despliegue (queda cifrada en el keystore de Foundry)
cast wallet import desplegador --interactive

# Primero en Arbitrum Sepolia
forge script script/DesplegarPagoAtomicoMXNB.s.sol \
  --rpc-url "$ARBITRUM_RPC_URL" --account desplegador --broadcast \
  --verify --etherscan-api-key "$ETHERSCAN_API_KEY"
```

`--verify` publica el código en Arbiscan. Después, pon la dirección desplegada en `CONTRATO_PAGOS` del backend.

## Despliegue desde GitHub Actions

El workflow [`Desplegar en Arbitrum Sepolia`](../.github/workflows/desplegar-sepolia.yml) despliega el contrato en la testnet sin instalar nada en tu computadora. Solo se puede lanzar desde `main` y ejecuta los tests antes de desplegar.

### Configuración (una sola vez)

1. Crea una wallet **nueva y exclusiva para testnet** y consíguele ETH de Arbitrum Sepolia en un faucet. No reutilices una clave de mainnet.
2. En el repositorio, ve a **Settings → Environments → New environment** y crea `arbitrum-sepolia`.
3. Dentro del environment, en **Environment secrets**, añade:

   | Secret | Valor |
   |--------|-------|
   | `DEPLOYER_PRIVATE_KEY` | Clave privada de la wallet del paso 1 (`0x...`). |
   | `ARBITRUM_SEPOLIA_RPC_URL` | URL de RPC de Arbitrum Sepolia (Alchemy, Infura, etc.). |
   | `ETHERSCAN_API_KEY` | Opcional: clave de [Etherscan](https://etherscan.io/apis) para verificar el código en Arbiscan. |

4. Opcional: en el environment, activa **Required reviewers** para que cada despliegue necesite tu aprobación.

### Lanzarlo

1. **Actions → Desplegar en Arbitrum Sepolia → Run workflow** (rama `main`).
2. Rellena tesorería, operador (la dirección de `OPERADOR_PRIVATE_KEY` del backend), owner y comisión.
3. Al terminar, el resumen del job muestra la dirección del contrato con enlaces a Arbiscan. El registro del despliegue queda como artefacto `despliegue-arbitrum-sepolia`.
4. En el backend, pon `ARBITRUM_TESTNET=1` y `CONTRATO_PAGOS=<dirección>`.

Para mainnet, despliega a mano con el owner en un multisig y después de la auditoría.

## Antes de producción

- Owner en un **multisig**, no en una wallet individual.
- **Auditoría externa** del contrato.
- Decidir la política de **reembolsos**: hoy el pago es definitivo porque los fondos van directo al creador.

---

[← Volver al índice](README.md)
