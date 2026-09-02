exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON users TO tilivo_runtime');
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON email_verification_tokens TO tilivo_runtime');
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON password_reset_tokens TO tilivo_runtime');
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON sessions TO tilivo_runtime');
  pgm.sql('GRANT SELECT, INSERT, UPDATE, DELETE ON totp_credentials TO tilivo_runtime');
  pgm.sql('GRANT SELECT, INSERT, UPDATE, DELETE ON recovery_codes TO tilivo_runtime');
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON two_factor_challenges TO tilivo_runtime');
  pgm.sql('GRANT SELECT, INSERT ON auth_attempts TO tilivo_runtime');
  pgm.sql('GRANT SELECT, INSERT ON audit_events TO tilivo_runtime');
  pgm.sql('GRANT SELECT, INSERT ON dev_email_outbox TO tilivo_runtime');
  pgm.sql('GRANT SELECT ON permissions TO tilivo_runtime');
};

exports.down = () => {
  // Grants are re-applied by migration up; no down action needed for safety.
};
