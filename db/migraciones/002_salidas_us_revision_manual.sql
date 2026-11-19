-- v2.2 -> v2.3: estado 'revision_manual' para envíos a Bridge con resultado incierto.
-- Solo para bases de datos creadas con un schema.sql anterior; una base nueva ya lo incluye.
BEGIN;

ALTER TABLE salidas_us DROP CONSTRAINT IF EXISTS salidas_us_estado_check;
ALTER TABLE salidas_us ADD CONSTRAINT salidas_us_estado_check CHECK (estado IN (
  'cotizando',
  'convirtiendo',
  'convertido',
  'enviando_bridge',
  'enviado_bridge',
  'completado_ach',
  'revision_manual',
  'fallido'
));

COMMIT;
