# Contrato `PagoAtomicoMXNB`

Contrato de pago en MXNB sobre Arbitrum. El comprador paga una orden en una sola transacción y el contrato reparte el monto entre el creador y la tesorería de la plataforma. El contrato nunca retiene fondos.

Código: [`contracts/PagoAtomicoMXNB.sol`](../contracts/PagoAtomicoMXNB.sol) · Tests: [`test/contracts/`](../test/contracts/) · Despliegue: [`script/DesplegarPagoAtomicoMXNB.s.sol`](../script/DesplegarPagoAtomicoMXNB.s.sol)

## Roles

| Rol | Quién | Puede |
|-----|-------|-------|
| **Operador** | El backend (`OPERADOR_PRIVATE_KEY`) | Crear y cancelar órdenes. |
| **Comprador** | La smart wallet fijada en cada orden | Pagar su orden. |
| **Owner** | Idealmente un multisig (Safe) | Cambiar tesorería, operador y comisión; pausar y reanudar; rescatar tokens enviados por error; transferir la administración en dos pasos. |

## Ciclo de una orden

1. El operador llama a `crearOrden(orderId, comprador, creador, monto, expiraEn)`. La comisión vigente se congela en la orden.
2. El comprador envía `approve(contrato, monto)` + `pagarOrden(orderId)` en una sola UserOperation.
3. El contrato marca la orden como pagada y transfiere `monto − comisión` al creador y la comisión a la tesorería.

Una orden **no se puede pagar** si no existe, ya está pagada, está cancelada, ha caducado (`block.timestamp >= expiraEn`), el contrato está en pausa o quien paga no es el comprador.

## Garantías

- **Caducidad:** cada orden tiene un `expiraEn`. El backend lo fija en `ahora + ORDEN_VIGENCIA_SEGUNDOS` (900 s por defecto) y marca como cancelada en la base de datos una orden que caducó sin pagarse.
- **Comisión máxima del 30 %** (`COMISION_MAXIMA_BPS = 3000`): ni el constructor ni `setComisionBps` aceptan más. Un cambio de comisión solo afecta a órdenes nuevas.
- **La administración no se puede abandonar:** `renounceOwnership` está deshabilitado. Para cambiar de owner se usa `transferOwnership` y el nuevo owner confirma con `acceptOwnership`.
- **Rescate de tokens:** `rescatarTokens(token, destino, monto)` recupera cualquier token enviado directamente al contrato por error.
- **Sin reentrada ni doble pago:** `nonReentrant`, y la orden se marca como pagada antes de mover fondos.

## Desarrollo

Requiere [Foundry](https://getfoundry.sh). Las dependencias (OpenZeppelin v5.6.1 y forge-std) son submódulos de git:

```bash
git submodule update --init   # o clonar con: git clone --recurse-submodules
forge build
forge test -vvv
```

El CI compila el contrato y ejecuta los tests en cada pull request (job `contrato`).

## Despliegue

El script lee los parámetros de variables de entorno:

| Variable | Valor |
|----------|-------|
| `MXNB_ADDRESS` | Proxy de MXNB de la red (ver [direcciones](arquitectura.md#direcciones-de-tokens)). |
| `TESORERIA_ADDRESS` | Wallet que recibe la comisión. |
| `OPERADOR_ADDRESS` | Dirección de `OPERADOR_PRIVATE_KEY` del backend. |
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

## Antes de producción

- Owner en un **multisig**, no en una wallet individual.
- **Auditoría externa** del contrato.
- Decidir la política de **reembolsos**: hoy el pago es definitivo porque los fondos van directo al creador.

---

[← Volver al índice](README.md)
