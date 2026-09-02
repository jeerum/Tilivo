exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS tax_codes_tenant_code_effective_from_unique
    ON tax_codes (tenant_id, code, effective_from)
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS tax_codes_tenant_code_effective_from_unique');
};
