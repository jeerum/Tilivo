exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql('GRANT SELECT ON permissions TO tilivo_runtime');
};

exports.down = () => {
  // Kept intentionally reversible only by re-applying migration history.
};
