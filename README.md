# 589

Orquestador de pagos en **MXNB** sobre **Arbitrum**: los compradores pagan a creadores con un contrato de pago atómico, y los fondos entran y salen del sistema mediante **Juno** (SPEI ↔ MXNB) y **Bridge** (USDC → ACH USD).

- Backend: Node.js + Express (`src/`)
- Contrato: Solidity + OpenZeppelin v5 (`contracts/`)
- Base de datos: PostgreSQL (`db/schema.sql`)

## Documentación

Consulta la carpeta [`docs/`](docs/README.md) para ver la guía de inicio y la arquitectura del proyecto.
