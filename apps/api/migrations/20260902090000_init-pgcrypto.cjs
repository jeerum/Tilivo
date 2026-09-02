exports.shorthands = undefined;

exports.up = (pgm) => {
  // pgcrypto provides gen_random_uuid() and is a foundation for all future
  // tenant/business tables. Trusted extension: no superuser required on PG17.
  pgm.createExtension('pgcrypto', { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropExtension('pgcrypto', { ifExists: true });
};
