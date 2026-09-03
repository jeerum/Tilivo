exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('employees', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    user_id: { type: 'uuid' }, employee_number: { type: 'text', notNull: true },
    first_name: { type: 'text', notNull: true }, last_name: { type: 'text', notNull: true }, preferred_name: { type: 'text' },
    personal_identity_code: { type: 'text' }, date_of_birth: { type: 'date' }, nationality: { type: 'text' },
    email: { type: 'text' }, phone: { type: 'text' }, address_line1: { type: 'text' }, address_line2: { type: 'text' },
    postal_code: { type: 'text' }, city: { type: 'text' }, country: { type: 'text', notNull: true, default: 'FI' },
    language: { type: 'text', notNull: true, default: 'FI' }, status: { type: 'text', notNull: true, default: 'ACTIVE' },
    emergency_contact_name: { type: 'text' }, emergency_contact_relationship: { type: 'text' }, emergency_contact_phone: { type: 'text' },
    internal_notes: { type: 'text' }, created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }, updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`ALTER TABLE employees ADD CONSTRAINT employees_status_check CHECK (status IN ('ACTIVE','INACTIVE','TERMINATED')), ADD CONSTRAINT employees_language_check CHECK (language IN ('FI','EN','ET')), ADD CONSTRAINT employees_email_check CHECK (email IS NULL OR position('@' in email) > 1), ADD CONSTRAINT employees_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL`);
  pgm.createIndex('employees', ['tenant_id', 'employee_number'], { unique: true });
  pgm.createIndex('employees', ['tenant_id', 'id'], { unique: true });
  pgm.createIndex('employees', ['tenant_id', 'status']);
  pgm.sql(`CREATE UNIQUE INDEX employees_personal_id_unique ON employees (tenant_id, personal_identity_code) WHERE personal_identity_code IS NOT NULL`);
  pgm.createTable('employments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') }, tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' }, employee_id: { type: 'uuid', notNull: true },
    employment_type: { type: 'text', notNull: true, default: 'PERMANENT' }, contract_type: { type: 'text', notNull: true, default: 'FULL_TIME' },
    start_date: { type: 'date', notNull: true }, end_date: { type: 'date' }, job_title: { type: 'text', notNull: true }, department: { type: 'text' }, cost_center: { type: 'text' }, project_code: { type: 'text' }, work_location: { type: 'text' },
    weekly_hours: { type: 'numeric(8,2)' }, daily_hours: { type: 'numeric(8,2)' }, working_days_per_week: { type: 'numeric(4,2)' }, work_schedule_type: { type: 'text' }, pay_type: { type: 'text', notNull: true, default: 'MONTHLY' },
    monthly_salary: { type: 'numeric(28,8)' }, hourly_rate: { type: 'numeric(28,8)' }, daily_rate: { type: 'numeric(28,8)' }, currency: { type: 'text', notNull: true, default: 'EUR' }, collective_agreement: { type: 'text' }, active: { type: 'boolean', notNull: true, default: true }, termination_reason: { type: 'text' }, termination_notes: { type: 'text' }, created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }, updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`ALTER TABLE employments ADD CONSTRAINT employments_employee_fk FOREIGN KEY (tenant_id,employee_id) REFERENCES employees(tenant_id,id) ON DELETE RESTRICT, ADD CONSTRAINT employments_dates_check CHECK (end_date IS NULL OR end_date >= start_date), ADD CONSTRAINT employments_hours_check CHECK ((weekly_hours IS NULL OR weekly_hours >= 0) AND (daily_hours IS NULL OR daily_hours >= 0) AND (working_days_per_week IS NULL OR working_days_per_week >= 0)), ADD CONSTRAINT employments_rates_check CHECK ((monthly_salary IS NULL OR monthly_salary >= 0) AND (hourly_rate IS NULL OR hourly_rate >= 0) AND (daily_rate IS NULL OR daily_rate >= 0)), ADD CONSTRAINT employments_type_check CHECK (employment_type IN ('PERMANENT','FIXED_TERM','TEMPORARY','OTHER')), ADD CONSTRAINT employments_contract_check CHECK (contract_type IN ('FULL_TIME','PART_TIME','ZERO_HOUR','OTHER')), ADD CONSTRAINT employments_pay_check CHECK (pay_type IN ('MONTHLY','HOURLY','DAILY','OTHER'))`);
  pgm.createIndex('employments', ['tenant_id', 'employee_id', 'start_date']); pgm.sql(`CREATE UNIQUE INDEX employments_active_unique ON employments (tenant_id, employee_id) WHERE active`);
  pgm.addColumns('employees', { iban: { type: 'text' }, bic: { type: 'text' }, account_holder_name: { type: 'text' }, tax_card_type: { type: 'text' }, withholding_percent: { type: 'numeric(6,3)' }, additional_percent: { type: 'numeric(6,3)' }, income_limit: { type: 'numeric(28,8)' }, tax_valid_from: { type: 'date' }, tax_valid_to: { type: 'date' }, tax_source_reference: { type: 'text' }, pension_insurance_type: { type: 'text' }, pension_provider: { type: 'text' }, pension_policy_reference: { type: 'text' }, accident_insurance_ready: { type: 'boolean', notNull: true, default: false }, unemployment_insurance_applicable: { type: 'boolean' }, insurance_exemption_notes: { type: 'text' }, home_municipality: { type: 'text' }, default_travel_origin: { type: 'text' }, company_car_ready: { type: 'boolean', notNull: true, default: false }, mileage_eligible: { type: 'boolean', notNull: true, default: false }, per_diem_eligible: { type: 'boolean', notNull: true, default: false } });
  pgm.sql(`ALTER TABLE employees ADD CONSTRAINT employees_percent_check CHECK ((withholding_percent IS NULL OR withholding_percent BETWEEN 0 AND 100) AND (additional_percent IS NULL OR additional_percent BETWEEN 0 AND 100) AND (income_limit IS NULL OR income_limit >= 0)), ADD CONSTRAINT employees_tax_dates_check CHECK (tax_valid_to IS NULL OR tax_valid_from IS NULL OR tax_valid_to >= tax_valid_from)`);
  pgm.sql(`INSERT INTO permissions (key,description) VALUES ('employees.read','Read employee registry'),('employees.create','Create employees'),('employees.update','Update employees'),('employees.manage_sensitive','Read and update sensitive employee data'),('employees.terminate','Terminate and reactivate employees') ON CONFLICT (key) DO NOTHING`);
  pgm.sql(`INSERT INTO role_permissions (tenant_id,role_id,permission_id) SELECT r.tenant_id,r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.name IN ('Owner','Admin','Accountant') AND p.key LIKE 'employees.%' ON CONFLICT (role_id,permission_id) DO NOTHING`);
  for (const table of ['employees','employments']) { pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY; CREATE POLICY tenant_all ON ${table} USING (tenant_id = public.tilivo_tenant_id()) WITH CHECK (tenant_id = public.tilivo_tenant_id()); GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO tilivo_runtime`); }
};

exports.down = (pgm) => { pgm.dropTable('employments'); pgm.dropTable('employees'); pgm.sql(`DELETE FROM role_permissions rp USING permissions p WHERE rp.permission_id=p.id AND p.key LIKE 'employees.%'; DELETE FROM permissions WHERE key LIKE 'employees.%'`); };
