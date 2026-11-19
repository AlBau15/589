-- Esquema v2.3 (Arbitrum + Juno + Bridge Ruta B completa + órdenes firmadas EIP-712 + revisión manual de envíos). Montos en unidades mínimas (6 decimales).

CREATE TABLE usuarios_perfil (
  user_id                   TEXT PRIMARY KEY,                -- userId de Privy
  wallet                    TEXT NOT NULL UNIQUE,            -- smart wallet de Privy, 0x... en minúsculas
  estado_onboarding         TEXT NOT NULL DEFAULT 'pendiente'
                            CHECK (estado_onboarding IN ('pendiente', 'en_proceso', 'completo')),
  clabe                     TEXT UNIQUE,                     -- CLABE de depósito (una por usuario, no se reasigna)
  juno_tag                  TEXT UNIQUE,                     -- identificador del usuario en Juno
  wallet_registrada_en_juno BOOLEAN NOT NULL DEFAULT FALSE,
  creado_en                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cuentas_bancarias (
  user_id              TEXT PRIMARY KEY REFERENCES usuarios_perfil(user_id),
  juno_bank_account_id UUID NOT NULL,
  clabe_ultimos4       CHAR(4),
  creado_en            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE items (
  item_id        TEXT PRIMARY KEY,
  monto          BIGINT NOT NULL CHECK (monto > 0),
  creador_wallet TEXT NOT NULL                               -- dirección que recibe la parte del creador
);

CREATE TABLE ordenes (
  order_id       CHAR(32) PRIMARY KEY,                       -- bytes16 en hex
  user_id        TEXT NOT NULL REFERENCES usuarios_perfil(user_id),
  item_id        TEXT NOT NULL REFERENCES items(item_id),
  monto          BIGINT NOT NULL CHECK (monto > 0),
  comprador      TEXT NOT NULL,
  creador        TEXT NOT NULL,
  estado         TEXT NOT NULL DEFAULT 'creada'
                 CHECK (estado IN ('creada', 'pagada', 'cancelada')),
  tx_hash        TEXT,
  expira_en      TIMESTAMPTZ NOT NULL,                       -- caducidad firmada en la orden (EIP-712)
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ordenes_user_idx ON ordenes (user_id);
CREATE INDEX ordenes_pendientes_idx ON ordenes (estado, creado_en);

CREATE TABLE juno_transacciones (
  id             UUID PRIMARY KEY,
  tipo           TEXT NOT NULL,
  estado         TEXT NOT NULL,
  payload        JSONB NOT NULL,
  creado_en      TIMESTAMPTZ NOT NULL,
  actualizado_en TIMESTAMPTZ NOT NULL,
  recibido_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE depositos (
  juno_tx_id       UUID PRIMARY KEY,
  user_id          TEXT REFERENCES usuarios_perfil(user_id),
  clabe            TEXT NOT NULL,
  monto            BIGINT NOT NULL CHECK (monto > 0),
  estado           TEXT NOT NULL
                   CHECK (estado IN ('recibido', 'retirando', 'en_wallet', 'huerfano', 'fallido')),
  idem_key_retiro  UUID NOT NULL,
  juno_retiro_id   UUID,
  intentos         INT NOT NULL DEFAULT 0,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX depositos_estado_idx ON depositos (estado, creado_en);

CREATE TABLE retiros_mx (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             TEXT NOT NULL REFERENCES usuarios_perfil(user_id),
  monto               BIGINT NOT NULL CHECK (monto > 0),
  wallet_origen       TEXT NOT NULL,
  estado              TEXT NOT NULL
                      CHECK (estado IN ('esperando_deposito', 'en_juno', 'redimiendo',
                                        'completado', 'fallido', 'expirado')),
  idem_key_redencion  UUID NOT NULL,
  juno_deposito_id    UUID,
  juno_redencion_id   UUID,
  intentos            INT NOT NULL DEFAULT 0,
  creado_en           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX retiros_mx_activo_idx ON retiros_mx (user_id)
  WHERE estado IN ('esperando_deposito', 'en_juno', 'redimiendo');

-- Ruta B: Tesorería MXNB -> USDC (Juno / Bitso) -> Arbitrum -> Bridge -> ACH USD
CREATE TABLE salidas_us (
  id                  UUID PRIMARY KEY,
  monto_mxnb          BIGINT NOT NULL CHECK (monto_mxnb > 0),
  monto_usdc          BIGINT,                                 -- USDC recibido tras conversión (6 decimales)
  estado              TEXT NOT NULL
                      CHECK (estado IN (
                        'cotizando',
                        'convirtiendo',
                        'convertido',
                        'enviando_bridge',
                        'enviado_bridge',
                        'completado_ach',
                        'revision_manual',                    -- envío incierto: no se reintenta solo
                        'fallido'
                      )),
  juno_quote_id       TEXT,
  juno_conversion_id  UUID,
  bitso_withdrawal_id TEXT,
  tx_hash_bridge      TEXT,
  intentos            INT NOT NULL DEFAULT 0,
  detalle             JSONB,
  creado_en           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX salidas_us_estado_idx ON salidas_us (estado, creado_en);

CREATE TABLE bridge_cuenta (
  id                     SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  customer_id            TEXT NOT NULL,
  external_account_id    TEXT NOT NULL,
  liquidation_address_id TEXT NOT NULL,
  liquidation_address    TEXT NOT NULL,
  chain                  TEXT NOT NULL,
  creado_en              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bridge_eventos (
  event_id    TEXT PRIMARY KEY,
  tipo        TEXT,
  payload     JSONB NOT NULL,
  recibido_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
