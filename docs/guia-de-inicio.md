# Guía de inicio

Esta guía explica cómo poner en marcha el orquestador de **589**.

## Requisitos

- Node.js 20.6 o superior (se usan `fetch`, `AbortSignal.timeout` y `--env-file` nativos).
- PostgreSQL 13 o superior (`gen_random_uuid()` sin extensiones).
- Cuentas y credenciales de:
  - **Privy** (autenticación y smart wallets con paymaster).
  - **Juno / Bitso** (Mint Platform: CLABEs, emisión, redención, conversión y retiros).
  - **Bridge** (liquidation address en Arbitrum hacia una cuenta ACH).
- Un nodo RPC de Arbitrum One o Arbitrum Sepolia.
- [Foundry](https://getfoundry.sh) para compilar, probar y desplegar el contrato.

## Instalación

1. Clona el repositorio:

   ```bash
   git clone --recurse-submodules https://github.com/albau15/589.git
   cd 589
   ```

2. Instala las dependencias del backend (definidas en `package.json`):

   ```bash
   npm install
   ```

3. Crea la base de datos y aplica el esquema:

   ```bash
   createdb pagos
   psql pagos -f db/schema.sql
   ```

   Si ya tenías una base de datos con un esquema anterior, aplica en orden los archivos de `db/migraciones/` en lugar de `schema.sql`.

4. Despliega `contracts/PagoAtomicoMXNB.sol` con Foundry siguiendo la guía del [contrato](contrato.md#despliegue).

5. Copia la configuración y rellénala:

   ```bash
   cp .env.example .env
   ```

## Variables de entorno

| Variable | Uso |
|----------|-----|
| `PORT` | Puerto HTTP (por defecto `3000`). |
| `DATABASE_URL` | Cadena de conexión a PostgreSQL. |
| `TRUST_PROXY_HOPS` | Saltos de proxy de confianza; afecta a `req.ip` y a la lista blanca de IPs de Juno. |
| `EJECUTAR_TRABAJADORES` | `0` para arrancar solo la API, sin trabajadores en segundo plano. |
| `ADMIN_API_SECRET` | Token Bearer de los endpoints de tesorería (`/api/tesoreria/*`). |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET` | Credenciales de Privy. |
| `ARBITRUM_RPC_URL` | RPC de Arbitrum. |
| `ARBITRUM_TESTNET` | `1` para Arbitrum Sepolia. |
| `CONTRATO_PAGOS` | Dirección del contrato `PagoAtomicoMXNB` desplegado. |
| `OPERADOR_PRIVATE_KEY` | Clave del operador que firma las órdenes (EIP-712). Solo firma: no envía transacciones ni necesita ETH. |
| `ORDEN_VIGENCIA_SEGUNDOS` | Tiempo para pagar una orden antes de que caduque en el contrato (por defecto `900`). |
| `MXNB_ADDRESS`, `USDC_ADDRESS` | Opcionales: sobrescriben las direcciones de los tokens. |
| `JUNO_BASE_URL`, `JUNO_ENTORNO` | Host de Juno y entorno (`stage` / `production`) para la lista de IPs de webhooks. |
| `JUNO_API_KEY`, `JUNO_API_SECRET` | Credenciales HMAC de Juno/Bitso. |
| `JUNO_BEARER_TOKEN` | Opcional: cabecera `BitsoAuth` adicional. |
| `JUNO_DEPOSIT_ADDRESS` | Dirección a la que el creador envía MXNB para retirar a México. |
| `JUNO_LIMITE_TRAVEL_RULE_MXNB` | Opcional: monto a partir del cual un retiro exige datos de Travel Rule. |
| `BITSO_API_URL` | Host de la API de Bitso para retiros de USDC. |
| `BRIDGE_API_URL` | Opcional: por defecto `https://api.bridge.xyz/v0`. |
| `BRIDGE_API_KEY`, `BRIDGE_CUSTOMER_ID`, `BRIDGE_EXTERNAL_ACCOUNT_ID` | Credenciales y cuenta ACH de Bridge. |
| `BRIDGE_RETURN_ADDRESS` | Dirección de devolución si Bridge rechaza un depósito. |
| `BRIDGE_WEBHOOK_PUBLIC_KEY` | Clave pública PEM para verificar webhooks de Bridge. |
| `RUTA_B_MODO_RETIRO` | `bitso_api` (por defecto) u `onchain_tesoreria`. |
| `BITSO_BRIDGE_CONTACT_ID` | Opcional: contacto beneficiario en Bitso. |
| `TESORERIA_USDC_PRIVATE_KEY` | Solo con `onchain_tesoreria`: wallet que envía USDC a Bridge. |

> Nunca subas `.env` al repositorio; está en `.gitignore`.

## Uso

```bash
npm start        # arranca src/servidor.js cargando la configuración de .env
npm run check    # comprueba la sintaxis de todos los archivos de src/
npm test         # tests del backend
```

Para arrancar solo la API, sin trabajadores en segundo plano, pon `EJECUTAR_TRABAJADORES=0` en `.env`.

Al arrancar, el servidor expone la API, escucha el evento `CompraConfirmada` del contrato y lanza los trabajadores periódicos (ver [arquitectura](arquitectura.md#trabajadores-en-segundo-plano)).

Configura en los paneles de Juno y Bridge los webhooks hacia:

- `POST https://<tu-dominio>/webhooks/juno`
- `POST https://<tu-dominio>/webhooks/bridge`

## Problemas frecuentes

| Síntoma | Causa probable |
|---------|----------------|
| `409 La smart wallet aún no está lista` en onboarding | Smart wallets o paymaster desactivados en el panel de Privy. |
| `403 IP no permitida` en `/webhooks/juno` | `JUNO_ENTORNO` no coincide con el entorno, o `TRUST_PROXY_HOPS` mal configurado detrás de un proxy. |
| `400 Firma inválida` en `/webhooks/bridge` | `BRIDGE_WEBHOOK_PUBLIC_KEY` incorrecta o reloj del servidor desfasado (> 10 min). |
| `400` al iniciar una salida a EE. UU. | El lote es menor que el mínimo de Juno (25,000 MXNB). |

---

[← Volver al índice](README.md)
