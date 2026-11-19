# Arquitectura

Este documento describe cómo está organizado el orquestador de **589**.

## Visión general

Los usuarios se autentican con **Privy** y reciben una smart wallet (ERC-4337) en **Arbitrum**. Todo el dinero dentro del sistema circula como **MXNB**, la stablecoin de peso mexicano de 6 decimales.

1. **Entrada:** el usuario deposita pesos por SPEI a una CLABE propia de **Juno**. Juno emite MXNB y el backend lo retira a la wallet del usuario.
2. **Compra:** el backend firma la orden fuera de la cadena (EIP-712), sin transacción ni gas. El comprador envía `approve` + `pagarOrden(orden, firma)` en una sola UserOperation; el contrato `PagoAtomicoMXNB` verifica la firma y reparte el pago entre creador y plataforma en la misma transacción.
3. **Salida A (México):** el creador envía MXNB a Juno y el backend pide una redención SPEI a su cuenta bancaria.
4. **Salida B (EE. UU.):** la tesorería convierte MXNB → USDC en Juno, envía el USDC a una *liquidation address* de **Bridge** y Bridge liquida en USD por ACH.

```text
           SPEI                 MXNB                     MXNB
 Banco MX ─────▶ Juno ───────────────▶ Wallet comprador ─────▶ PagoAtomicoMXNB
                                                                 │        │
                                                       creador ◀─┘        └─▶ tesorería
                                                          │                     │
                        Ruta A: MXNB → Juno → SPEI ◀──────┘                     │
       Ruta B: MXNB → USDC (Juno) → Bridge liquidation address → ACH USD ◀──────┘
```

## Estructura de carpetas

```text
589/
├── .env.example              # Plantilla de configuración
├── contracts/
│   └── PagoAtomicoMXNB.sol   # Contrato de pago atómico con reparto
├── lib/                      # Submódulos: OpenZeppelin y forge-std
├── script/                   # Script de despliegue (Foundry)
├── test/
│   ├── backend/              # Tests del backend (node --test)
│   └── contracts/            # Tests del contrato (Foundry)
├── foundry.toml              # Configuración de Foundry
├── db/
│   ├── schema.sql            # Esquema PostgreSQL (v2.2)
│   └── migraciones/          # Cambios para bases de datos existentes
├── docs/                     # Esta documentación
└── src/
    ├── servidor.js           # Punto de entrada: Express, órdenes, arranque de trabajadores
    ├── onboarding.js         # Alta: smart wallet, CLABE y registro de wallet en Juno
    ├── salidas.js            # Rutas A y B y sus trabajadores
    ├── webhooks.js           # Webhooks de Juno (verificados con su API) y Bridge (firma)
    ├── juno.js               # Cliente HMAC de Juno Mint Platform y retiros de Bitso
    ├── bridge.js             # Cliente de Bridge y verificación de webhooks
    ├── chain.js              # Acceso a Arbitrum con viem (contrato, MXNB, USDC)
    ├── firmas.js             # Firma EIP-712 de órdenes
    ├── db.js                 # Consultas SQL y máquinas de estado
    ├── unidades.js           # Conversión de montos a micro-unidades (BigInt)
    ├── verificacion.js       # Confirmación de webhooks de Juno contra su API
    └── errores.js            # ¿Reintentar o revisión manual?
```

## Componentes principales

| Componente | Responsabilidad |
|------------|-----------------|
| `servidor.js` | Autentica con Privy, aplica rate limit (10 req/min por usuario), firma órdenes (EIP-712) y devuelve las `calls` que envía el cliente. Reconcilia órdenes pendientes con el estado del contrato. |
| `onboarding.js` | Toma un bloqueo optimista en `usuarios_perfil`, crea la CLABE en Juno, registra la smart wallet y marca el perfil como `completo`. Es idempotente y se puede reintentar. |
| `salidas.js` | Ruta A (`/api/retiros/mx`) para creadores y Ruta B (`/api/tesoreria/salidas-us`) protegida con `ADMIN_API_SECRET`. |
| `webhooks.js` | Trata cada webhook de Juno solo como aviso: consulta la transacción en la API de Juno (`verificacion.js`) y, con esos datos, avanza los estados de depósitos, retiros, redenciones y conversiones. Verifica la firma de los eventos de Bridge y cierra lotes ACH. |
| `verificacion.js` | Extrae de la respuesta de Juno el tipo, el estado, el monto y los datos de destino; si falta alguno necesario, falla cerrada. |
| `errores.js` | Decide si una operación que mueve dinero se puede reintentar o debe ir a revisión manual. |
| `juno.js` | Firma cada llamada con HMAC-SHA256 (`nonce + método + ruta + cuerpo`) y envía `X-Idempotency-Key` cuando corresponde. |
| `chain.js` | Lecturas y escrituras en Arbitrum: comisión y estado de órdenes, saldos, transferencias de USDC de tesorería y escucha de `CompraConfirmada`. |
| `firmas.js` | Tipos, dominio y firma EIP-712 de órdenes; debe coincidir con `ORDEN_TYPEHASH` del contrato. |
| `db.js` | Reclama trabajo con `FOR UPDATE SKIP LOCKED` para que varios trabajadores no procesen la misma fila. |
| `unidades.js` | Convierte montos de texto a BigInt de 6 decimales; nunca se usan flotantes con dinero. |

## API HTTP

| Método y ruta | Autenticación | Descripción |
|---------------|---------------|-------------|
| `POST /api/onboarding` | Privy | Da de alta al usuario y devuelve su CLABE y wallet. |
| `POST /api/ordenes` | Privy | Crea y firma una orden para `itemId` y devuelve `expiraEn` y `calls` (`approve` + `pagarOrden(orden, firma)`). |
| `GET /api/ordenes/:orderId` | Privy | Estado de una orden propia. |
| `POST /api/retiros/mx` | Privy | Inicia un retiro a México; devuelve la dirección de Juno a la que enviar MXNB. |
| `GET /api/retiros/mx/:id` | Privy | Estado de un retiro propio. |
| `POST /api/tesoreria/salidas-us` | `ADMIN_API_SECRET` | Inicia un lote MXNB → USDC → ACH (mínimo 25,000 MXNB). |
| `GET /api/tesoreria/salidas-us` | `ADMIN_API_SECRET` | Últimos 25 lotes. |
| `POST /webhooks/juno` | IPs de Juno | Eventos de transacciones de Juno. |
| `POST /webhooks/bridge` | Firma RSA | Eventos de Bridge. |

## Máquinas de estado

**Órdenes** (`ordenes.estado`): `creada` → `pagada` | `cancelada`.

**Depósitos SPEI** (`depositos.estado`): `recibido` → `retirando` → `en_wallet` | `fallido`. Un depósito a una CLABE desconocida queda como `huerfano`.

**Retiros a México** (`retiros_mx.estado`): `esperando_deposito` → `en_juno` → `redimiendo` → `completado` | `fallido`. Caduca a `expirado` si no llega el MXNB en 1 hora; si el MXNB llega después (hasta 7 días), el retiro se reactiva en vez de dejar los fondos varados en Juno. Cada usuario solo puede tener un retiro activo.

**Salidas a EE. UU.** (`salidas_us.estado`): `cotizando` → `convirtiendo` → `convertido` → `enviando_bridge` → `enviado_bridge` → `completado_ach`, o `fallido` / `revision_manual`.

Los reintentos suben `intentos`; tras 5 fallos la fila pasa a `fallido`. Los depósitos y redenciones atascados sin id externo durante más de 5 minutos se devuelven a la cola (son seguros de reintentar porque usan claves de idempotencia de Juno).

### Envíos a Bridge: nunca dos veces

El envío de USDC a Bridge no se reintenta si hay duda de que el dinero haya salido:

- El tx hash (modo on-chain) o el id del retiro de Bitso se guarda en cuanto existe, antes de esperar confirmación.
- Un fallo **antes** de mover dinero (sin saldo, sin dirección de Bridge) vuelve a la cola.
- Un fallo **después** de intentarlo solo se reintenta si el proveedor lo rechazó explícitamente (HTTP 4xx salvo 408/409). Timeouts, errores de red, 5xx, una transacción revertida o un proceso interrumpido llevan el lote a **`revision_manual`**, con el error en `detalle`.

Para resolver un lote en `revision_manual`, comprueba en Arbiscan (dirección de tesorería) o en Bitso si el USDC salió:

```sql
-- Salió: guarda la referencia y deja que el webhook de Bridge lo cierre
UPDATE salidas_us SET estado = 'enviado_bridge', tx_hash_bridge = '0x...' WHERE id = '<id>' AND estado = 'revision_manual';
-- No salió: devuélvelo a la cola
UPDATE salidas_us SET estado = 'convertido' WHERE id = '<id>' AND estado = 'revision_manual';
```

### Webhooks de Juno

Un webhook solo indica que hay que revisar una transacción. El backend la consulta con `GET /mint_platform/v1/transactions/{id}` (la API key necesita el permiso *View account information*) y usa el tipo, el estado, el monto, la CLABE y la dirección de origen de esa respuesta, nunca del cuerpo del webhook. Si Juno no conoce el id, se responde 404; si falta un dato necesario, 500 para que Juno reintente. La lista blanca de IPs se mantiene como segunda barrera y depende de `TRUST_PROXY_HOPS`.

## Trabajadores en segundo plano

Se arrancan en `servidor.js` salvo que `EJECUTAR_TRABAJADORES=0`:

| Trabajador | Intervalo | Función |
|------------|-----------|---------|
| `depositos` | 10 s | Envía el MXNB emitido por SPEI a la wallet del usuario. |
| `retiros-mx` | 10 s | Pide a Juno la redención SPEI de los retiros `en_juno`. |
| `salidas-us` | 15 s | Envía el USDC convertido a la liquidation address de Bridge. |
| `retiros-bitso` | 30 s | En modo `bitso_api`, consulta en Bitso el tx hash de cada envío y lo guarda para que el webhook de Bridge pueda cerrar el lote. Si Bitso reporta el retiro como fallido, marca el lote `fallido` para revisión manual. |
| `reconciliar-ordenes` | 30 s | Consulta en cadena las órdenes `creada` de hace más de 60 s: las marca como pagadas, o como canceladas si se cancelaron o caducaron. |

Además, `vigilarCompras` escucha `CompraConfirmada` para marcar órdenes pagadas al instante.

## Contrato `PagoAtomicoMXNB`

- El **operador** (backend) firma cada orden fuera de la cadena con comprador, creador, monto, comisión y caducidad fijos. No envía transacciones.
- Solo el **comprador** de la orden puede pagarla, una sola vez y antes de que caduque. El contrato verifica la firma, marca la orden como pagada antes de mover fondos, y `nonReentrant` evita la reentrada.
- El **owner** (idealmente un multisig, con `Ownable2Step`) puede cambiar tesorería, operador y comisión (máximo 30 %), pausar el contrato y rescatar tokens enviados por error. No puede renunciar a la administración.

Detalles, tests y despliegue en [Contrato](contrato.md).

## Direcciones de tokens

| Token | Arbitrum One | Arbitrum Sepolia |
|-------|--------------|------------------|
| MXNB (proxy) | `0xF197FFC28c23E0309B5559e7a166f2c6164C80aA` | `0x82B9e52b26A2954E113F94Ff26647754d5a4247D` |
| USDC nativo | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` |

## Decisiones de diseño

- **Montos en BigInt de 6 decimales** en todo el backend y en `BIGINT` en la base de datos, para evitar errores de redondeo.
- **Idempotencia:** claves de idempotencia por operación en Juno y Bridge, `ON CONFLICT` en los webhooks y transiciones de estado condicionadas (`WHERE estado = ...`).
- **Pago atómico:** el reparto creador/plataforma ocurre dentro de la misma transacción del pago, sin custodia intermedia.
- **Ruta B por lotes:** Juno exige un mínimo de 25,000 MXNB por conversión a USDC, por eso la tesorería agrupa las salidas a EE. UU.

---

[← Volver al índice](README.md)
