exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('totp_credentials', {
    last_used_counter: { type: 'bigint' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('totp_credentials', ['last_used_counter']);
};
