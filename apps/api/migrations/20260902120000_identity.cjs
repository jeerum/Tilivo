exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    email: { type: 'text', notNull: true },
    email_normalized: { type: 'text', notNull: true },
    password_hash: { type: 'text', notNull: true },
    email_verified_at: { type: 'timestamptz' },
    status: { type: 'text', notNull: true, default: 'ACTIVE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('users', 'email_normalized', { unique: true, name: 'users_email_normalized_unique' });

  pgm.createTable('email_verification_tokens', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    token_hash: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('email_verification_tokens', 'token_hash', { unique: true });
  pgm.createIndex('email_verification_tokens', ['user_id', 'expires_at']);

  pgm.createTable('password_reset_tokens', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    token_hash: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('password_reset_tokens', 'token_hash', { unique: true });
  pgm.createIndex('password_reset_tokens', ['user_id', 'expires_at']);

  pgm.createTable('sessions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    token_hash: { type: 'text', notNull: true },
    csrf_token_hash: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true },
    last_seen_at: { type: 'timestamptz' },
    revoked_at: { type: 'timestamptz' },
    remember_me: { type: 'boolean', notNull: true, default: false },
    ip_metadata: { type: 'text', notNull: true, default: '{}' },
    user_agent_metadata: { type: 'text', notNull: true, default: '' },
  });
  pgm.createIndex('sessions', 'token_hash', { unique: true });
  pgm.createIndex('sessions', ['user_id', 'created_at']);
  pgm.createIndex('sessions', 'expires_at');

  pgm.createTable('totp_credentials', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    secret_encrypted: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    confirmed_at: { type: 'timestamptz' },
    last_used_at: { type: 'timestamptz' },
  });
  pgm.createIndex('totp_credentials', 'user_id', { unique: true });

  pgm.createTable('recovery_codes', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    code_hash: { type: 'text', notNull: true },
    used_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('recovery_codes', ['user_id', 'code_hash'], { unique: true });

  pgm.createTable('two_factor_challenges', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    token_hash: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
  });
  pgm.createIndex('two_factor_challenges', 'token_hash', { unique: true });
  pgm.createIndex('two_factor_challenges', ['user_id', 'expires_at']);

  pgm.createTable('auth_attempts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    purpose: { type: 'text', notNull: true },
    email_normalized: { type: 'text' },
    ip: { type: 'text' },
    success: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('auth_attempts', ['email_normalized', 'purpose', 'created_at']);
  pgm.createIndex('auth_attempts', ['ip', 'purpose', 'created_at']);
  pgm.createIndex('auth_attempts', 'created_at');

  pgm.createTable('audit_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    action: { type: 'text', notNull: true },
    metadata: { type: 'text', notNull: true, default: '{}' },
    ip_metadata: { type: 'text', notNull: true, default: '{}' },
    user_agent: { type: 'text', notNull: true, default: '' },
    trace_id: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('audit_events', ['user_id', 'created_at']);
  pgm.createIndex('audit_events', ['action', 'created_at']);

  pgm.createTable('dev_email_outbox', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    recipient_email: { type: 'text', notNull: true },
    subject: { type: 'text', notNull: true },
    body: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('dev_email_outbox', 'recipient_email');
};

exports.down = (pgm) => {
  pgm.dropTable('dev_email_outbox');
  pgm.dropTable('audit_events');
  pgm.dropTable('auth_attempts');
  pgm.dropTable('two_factor_challenges');
  pgm.dropTable('recovery_codes');
  pgm.dropTable('totp_credentials');
  pgm.dropTable('sessions');
  pgm.dropTable('password_reset_tokens');
  pgm.dropTable('email_verification_tokens');
  pgm.dropTable('users');
};
