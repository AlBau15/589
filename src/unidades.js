// Utilidades compartidas

export const DECIMALES_MXNB = 6;

// "500.25" -> 500250000n. Nunca se usan flotantes con dinero.
export function aMicro(valor) {
  const s = String(valor).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`Monto inválido: ${s}`);
  const [entero, decimales = ''] = s.split('.');
  return BigInt(entero + decimales.padEnd(DECIMALES_MXNB, '0'));
}

// 500250000n -> "500.25"
export function deMicro(micro) {
  const bi = BigInt(micro);
  if (bi < 0n) throw new Error('Monto negativo no soportado');
  const s = bi.toString().padStart(DECIMALES_MXNB + 1, '0');
  const entero = s.slice(0, -DECIMALES_MXNB);
  const decimales = s.slice(-DECIMALES_MXNB).replace(/0+$/, '');
  return decimales ? `${entero}.${decimales}` : entero;
}

// Envuelve un handler async de Express para no repetir try/catch
export const seguro = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((error) => {
    console.error(`${req.method} ${req.path}:`, error);
    if (!res.headersSent) res.status(500).json({ exito: false, error: 'Error interno' });
  });
