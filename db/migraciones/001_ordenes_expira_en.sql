-- v2.1 -> v2.2: caducidad de órdenes firmadas (EIP-712).
-- Solo para bases de datos creadas con un schema.sql anterior; una base nueva ya la incluye.
BEGIN;

ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS expira_en TIMESTAMPTZ;

-- Las órdenes existentes se crearon con el contrato anterior: se les da la vigencia por defecto (15 min).
UPDATE ordenes SET expira_en = creado_en + interval '15 minutes' WHERE expira_en IS NULL;

ALTER TABLE ordenes ALTER COLUMN expira_en SET NOT NULL;

COMMIT;
