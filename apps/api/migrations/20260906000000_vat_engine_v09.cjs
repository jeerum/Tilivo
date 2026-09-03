exports.shorthands = undefined;

/*
 * v0.9 VAT / ALV engine.
 *
 * Adds the semantic tax-code model, freezes VAT metadata on journal lines
 * and sales/purchase invoice lines, adds tax permissions and seeds the
 * statutory Finnish tax-code set (with rate history) for existing tenants.
 *
 * Rate/rule sources (verified 2026-09-03):
 * - vero.fi Rates of VAT
 * - vero.fi VAT reverse charge in the construction sector
 * - vero.fi Intra-Community trade
 * - vero.fi Value-added taxation of cross-border supply and acquisition
 *   of services
 */

// Mirror of apps/api/src/services/vatSeed.ts (kept in sync deliberately).
const RC_CONSTRUCTION_NOTES = {
  fi: 'Lasku ei sis' + '\u00e4' + 'll' + '\u00e4' + ' arvonlis' + '\u00e4' + 'veroa. Rakennusalan k' + '\u00e4' + '\u00e4' + 'nnetty verovelvollisuus: ostaja on verovelvollinen maksamaan arvonlis' + '\u00e4' + 'veron (AVL 8 c ' + '\u00a7' + ' / direktiivin 2006/112/EY 199 artikla). Ostajan Y-tunnus: {buyer_id}',
  en: 'This invoice does not include VAT. VAT reverse charge in the construction sector: the buyer is liable to pay the VAT (Section 8 c of the Finnish Value Added Tax Act / Article 199 of Directive 2006/112/EC). Buyer Business ID: {buyer_id}',
  et: 'Arve ei sisalda k' + '\u00e4' + 'ibemaksu. Ehitussektori p' + '\u00f6' + '\u00f6' + 'rdmaksustamine: ostja on kohustatud tasuma k' + '\u00e4' + 'ibemaksu (AVL ' + '\u00a7' + ' 8 c / direktiivi 2006/112/E' + '\u00dc' + ' artikkel 199). Ostja registrikood: {buyer_id}',
};
const EU_GOODS_NOTES = {
  fi: 'VAT 0 %, yhteis' + '\u00f6' + 'myynti (AVL 72 a ' + '\u00a7' + '). Ostajan ALV-tunnus: {vat_id}',
  en: 'VAT 0%, intra-Community supply. Buyer VAT number: {vat_id}',
  et: 'KM 0%, ' + '\u00fc' + 'hendusesisene m' + '\u00fc' + '' + '\u00fc' + 'k. Ostja k' + '\u00e4' + 'ibemaksukohustuslase number: {vat_id}',
};
const EU_SERVICE_NOTES = {
  fi: 'VAT 0 %, k' + '\u00e4' + '\u00e4' + 'nnetty verovelvollisuus. Palvelu myyd' + '\u00e4' + '\u00e4' + 'n yritysasiakkaalle toiseen EU-maahan; verokohtelu m' + '\u00e4' + '\u00e4' + 'r' + '\u00e4' + 'ytyy ostajan sijoittautumismaan mukaan (AVL 65 ' + '\u00a7' + '). Ostajan ALV-tunnus: {vat_id}',
  en: 'VAT 0%, reverse charge. Service supplied to a VAT-registered business in another EU Member State; place of supply is where the customer is established. Buyer VAT number: {vat_id}',
  et: 'KM 0%, p' + '\u00f6' + '\u00f6' + 'rdmaksustamine. Teenus osutatakse teises ELi liikmesriigis asuvale ettev' + '\u00f5' + 'tjast kliendile; maksustamiskoht on kliendi asukohariik. Ostja k' + '\u00e4' + 'ibemaksukohustuslase number: {vat_id}',
};
const EXPORT_NOTES = {
  fi: 'VAT 0 % ' + '\u2014' + ' vienti EU:n ulkopuolelle.',
  en: 'VAT 0% ' + '\u2014' + ' export outside the EU.',
  et: 'KM 0% ' + '\u2014' + ' eksport v' + '\u00e4' + 'ljaspoole ELi.',
};
const EXEMPT_NOTES = {
  fi: 'Arvonlis' + '\u00e4' + 'veroton myynti.',
  en: 'VAT exempt supply.',
  et: 'K' + '\u00e4' + 'ibemaksuvaba m' + '\u00fc' + '' + '\u00fc' + 'k.',
};
const RC_PURCHASE_NOTES = {
  fi: 'K' + '\u00e4' + '\u00e4' + 'nnetty verovelvollisuus: ostaja ilmoittaa ja maksaa arvonlis' + '\u00e4' + 'veron.',
  en: 'Reverse charge: the buyer reports and pays the VAT.',
  et: 'P' + '\u00f6' + '\u00f6' + 'rdmaksustamine: ostja deklareerib ja tasub k' + '\u00e4' + 'ibemaksu.',
};
const ACQUISITION_NOTES = {
  fi: 'Yhteis' + '\u00f6' + 'hankinta / k' + '\u00e4' + '\u00e4' + 'nnetty verovelvollisuus: ostaja ilmoittaa ja maksaa arvonlis' + '\u00e4' + 'veron Suomessa.',
  en: 'Intra-Community acquisition / reverse charge: the buyer reports and pays Finnish VAT.',
  et: '' + '\u00dc' + 'hendusesisene soetamine / p' + '\u00f6' + '\u00f6' + 'rdmaksustamine: ostja deklareerib ja tasub Soome k' + '\u00e4' + 'ibemaksu.',
};
const IMPORT_NOTES = {
  fi: 'Tuontivero: tuonnin arvonlis' + '\u00e4' + 'vero ilmoitetaan ja v' + '\u00e4' + 'hennet' + '\u00e4' + '\u00e4' + 'n verokaudella.',
  en: 'Import VAT: import VAT is reported and deducted for the tax period when the deduction right applies.',
  et: 'Impordik' + '\u00e4' + 'ibemaks: impordik' + '\u00e4' + 'ibemaks deklareeritakse ja arvatakse maha, kui mahaarvamis' + '\u00f5' + 'igus kehtib.',
};

// [code, name, rate, legacyType, treatment, direction, effectiveFrom, effectiveTo, reporting, deductible, rc, eu, export, import, legalNotes]
const SEED = [
  ['FI_SALES_STD', 'Finnish standard VAT 24 %', '24', 'VAT', 'STANDARD', 'SALES', '2013-01-01', '2024-08-31', 'DOMESTIC_OUTPUT_VAT', '100', false, false, false, false, {}],
  ['FI_SALES_STD', 'Finnish standard VAT 25.5 %', '25.5', 'VAT', 'STANDARD', 'SALES', '2024-09-01', null, 'DOMESTIC_OUTPUT_VAT', '100', false, false, false, false, {}],
  ['FI_PURCHASE_STD', 'Finnish standard VAT 24 % (purchase)', '24', 'VAT', 'STANDARD', 'PURCHASE', '2013-01-01', '2024-08-31', 'DOMESTIC_INPUT_VAT', '100', false, false, false, false, {}],
  ['FI_PURCHASE_STD', 'Finnish standard VAT 25.5 % (purchase)', '25.5', 'VAT', 'STANDARD', 'PURCHASE', '2024-09-01', null, 'DOMESTIC_INPUT_VAT', '100', false, false, false, false, {}],
  ['FI_SALES_REDUCED_MAIN', 'Finnish reduced VAT 14 %', '14', 'VAT', 'REDUCED', 'SALES', '2013-01-01', '2025-12-31', 'DOMESTIC_OUTPUT_VAT', '100', false, false, false, false, {}],
  ['FI_SALES_REDUCED_MAIN', 'Finnish reduced VAT 13.5 %', '13.5', 'VAT', 'REDUCED', 'SALES', '2026-01-01', null, 'DOMESTIC_OUTPUT_VAT', '100', false, false, false, false, {}],
  ['FI_PURCHASE_REDUCED_MAIN', 'Finnish reduced VAT 14 % (purchase)', '14', 'VAT', 'REDUCED', 'PURCHASE', '2013-01-01', '2025-12-31', 'DOMESTIC_INPUT_VAT', '100', false, false, false, false, {}],
  ['FI_PURCHASE_REDUCED_MAIN', 'Finnish reduced VAT 13.5 % (purchase)', '13.5', 'VAT', 'REDUCED', 'PURCHASE', '2026-01-01', null, 'DOMESTIC_INPUT_VAT', '100', false, false, false, false, {}],
  ['FI_SALES_REDUCED_10', 'Finnish reduced VAT 10 %', '10', 'VAT', 'REDUCED', 'SALES', '2013-01-01', null, 'DOMESTIC_OUTPUT_VAT', '100', false, false, false, false, {}],
  ['FI_PURCHASE_REDUCED_10', 'Finnish reduced VAT 10 % (purchase)', '10', 'VAT', 'REDUCED', 'PURCHASE', '2013-01-01', null, 'DOMESTIC_INPUT_VAT', '100', false, false, false, false, {}],
  ['FI_SALES_ZERO', 'Taxable sale at 0 %', '0', 'ZERO', 'ZERO_RATED', 'SALES', '2013-01-01', null, 'ZERO_RATED', '100', false, false, false, false, {}],
  ['FI_SALES_EXEMPT', 'VAT-exempt sale', '0', 'EXEMPT', 'EXEMPT', 'SALES', '2013-01-01', null, 'EXEMPT', '100', false, false, false, false, EXEMPT_NOTES],
  ['FI_PURCHASE_EXEMPT', 'VAT-exempt purchase', '0', 'EXEMPT', 'EXEMPT', 'PURCHASE', '2013-01-01', null, 'EXEMPT', '0', false, false, false, false, {}],
  ['FI_EU_GOODS_SALE', 'Intra-EU B2B goods sale', '0', 'ZERO', 'EU_GOODS_SUPPLY', 'SALES', '2013-01-01', null, 'EU_GOODS_SUPPLY', '100', false, true, false, false, EU_GOODS_NOTES],
  ['FI_EU_GOODS_PURCHASE', 'Intra-EU B2B goods acquisition', '25.5', 'VAT', 'EU_GOODS_ACQUISITION', 'PURCHASE', '2024-09-01', null, 'EU_GOODS_ACQUISITION', '100', false, true, false, false, ACQUISITION_NOTES],
  ['FI_EU_SERVICE_SALE', 'Intra-EU B2B service sale', '0', 'ZERO', 'EU_SERVICE_SUPPLY', 'SALES', '2013-01-01', null, 'EU_SERVICES_SUPPLY', '100', false, true, false, false, EU_SERVICE_NOTES],
  ['FI_EU_SERVICE_PURCHASE', 'Intra-EU B2B service acquisition', '25.5', 'VAT', 'EU_SERVICE_ACQUISITION', 'PURCHASE', '2024-09-01', null, 'EU_SERVICES_ACQUISITION', '100', false, true, false, false, ACQUISITION_NOTES],
  ['FI_EXPORT', 'Export outside the EU', '0', 'ZERO', 'EXPORT', 'SALES', '2013-01-01', null, 'EXPORT', '100', false, false, true, false, EXPORT_NOTES],
  ['FI_IMPORT', 'Import VAT (self-assessed)', '25.5', 'VAT', 'IMPORT', 'PURCHASE', '2024-09-01', null, 'IMPORT', '100', false, false, false, true, IMPORT_NOTES],
  ['FI_RC_PURCHASE', 'Reverse-charge purchase', '25.5', 'REVERSE_CHARGE', 'REVERSE_CHARGE', 'PURCHASE', '2024-09-01', null, 'REVERSE_CHARGE', '100', true, false, false, false, RC_PURCHASE_NOTES],
  ['FI_CONSTRUCTION_RC_SALE', 'Construction reverse-charge sale', '0', 'REVERSE_CHARGE', 'CONSTRUCTION_REVERSE_CHARGE', 'SALES', '2024-09-01', null, 'CONSTRUCTION_RC', '100', true, false, false, false, RC_CONSTRUCTION_NOTES],
  ['FI_CONSTRUCTION_RC_PURCHASE', 'Construction reverse-charge purchase', '25.5', 'REVERSE_CHARGE', 'CONSTRUCTION_REVERSE_CHARGE', 'PURCHASE', '2024-09-01', null, 'CONSTRUCTION_RC', '100', true, false, false, false, RC_PURCHASE_NOTES],
];

const sqlEscape = (value) => String(value).replace(/'/g, "''");

exports.up = (pgm) => {
  // -------------------------------------------------------------------------
  // 1. tax_codes: semantic model
  // -------------------------------------------------------------------------
  pgm.addColumns('tax_codes', {
    direction: { type: 'text', notNull: true, default: 'BOTH' },
    treatment: { type: 'text', notNull: true, default: 'STANDARD' },
    reverse_charge: { type: 'boolean', notNull: true, default: false },
    intra_eu: { type: 'boolean', notNull: true, default: false },
    is_export: { type: 'boolean', notNull: true, default: false },
    is_import: { type: 'boolean', notNull: true, default: false },
    deductible_percent: { type: 'numeric(5,2)', notNull: true, default: 100 },
    legal_notes: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    is_system: { type: 'boolean', notNull: true, default: false },
  });

  // Backfill legacy `type` snapshots into the semantic treatment field.
  pgm.sql(`
    UPDATE tax_codes
    SET treatment = CASE upper(type)
      WHEN 'ZERO' THEN 'ZERO_RATED'
      WHEN 'ZERO_RATED' THEN 'ZERO_RATED'
      WHEN 'EXEMPT' THEN 'EXEMPT'
      WHEN 'REVERSE_CHARGE' THEN 'REVERSE_CHARGE'
      WHEN 'RC' THEN 'REVERSE_CHARGE'
      WHEN 'REDUCED' THEN 'REDUCED'
      WHEN 'EU_GOODS_SALE' THEN 'EU_GOODS_SUPPLY'
      WHEN 'EU_GOODS_PURCHASE' THEN 'EU_GOODS_ACQUISITION'
      WHEN 'EU_SERVICE_SALE' THEN 'EU_SERVICE_SUPPLY'
      WHEN 'EU_SERVICE_PURCHASE' THEN 'EU_SERVICE_ACQUISITION'
      WHEN 'EXPORT' THEN 'EXPORT'
      WHEN 'IMPORT' THEN 'IMPORT'
      WHEN 'CONSTRUCTION_REVERSE_CHARGE' THEN 'CONSTRUCTION_REVERSE_CHARGE'
      WHEN 'OWN_USE' THEN 'OWN_USE'
      ELSE 'STANDARD'
    END
  `);

  pgm.addConstraint('tax_codes', 'tax_codes_direction_check', {
    check: "direction IN ('SALES','PURCHASE','BOTH')",
  });
  pgm.addConstraint('tax_codes', 'tax_codes_treatment_check', {
    check: "treatment IN ('STANDARD','REDUCED','ZERO_RATED','EXEMPT','EU_GOODS_SUPPLY','EU_GOODS_ACQUISITION','EU_SERVICE_SUPPLY','EU_SERVICE_ACQUISITION','EXPORT','IMPORT','REVERSE_CHARGE','CONSTRUCTION_REVERSE_CHARGE','OWN_USE')",
  });
  pgm.addConstraint('tax_codes', 'tax_codes_deductible_check', {
    check: 'deductible_percent >= 0 AND deductible_percent <= 100',
  });
  pgm.createIndex('tax_codes', ['tenant_id', 'direction', 'is_active', 'treatment']);
  pgm.createIndex('tax_codes', ['tenant_id', 'country_code', 'effective_from']);

  // -------------------------------------------------------------------------
  // 2. journal_lines: frozen VAT metadata
  // -------------------------------------------------------------------------
  pgm.addColumns('journal_lines', {
    tax_code_snapshot: { type: 'text' },
    tax_treatment_snapshot: { type: 'text' },
    taxable_base_snapshot: { type: 'numeric(28,8)' },
    tax_amount_snapshot: { type: 'numeric(28,8)' },
    tax_deductible_snapshot: { type: 'numeric(28,8)' },
    tax_nondeductible_snapshot: { type: 'numeric(28,8)' },
    tax_leg_type: { type: 'text' },
    tax_reporting_classification: { type: 'text' },
    tax_legal_note: { type: 'text' },
  });
  pgm.createIndex('journal_lines', ['tenant_id', 'tax_code_id']);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS journal_lines_tax_reporting_classification_idx
    ON journal_lines (tenant_id, tax_reporting_classification)
    WHERE tax_reporting_classification IS NOT NULL
  `);

  // -------------------------------------------------------------------------
  // 3. Invoice line snapshots for rendering after issue
  // -------------------------------------------------------------------------
  pgm.addColumns('sales_invoice_lines', {
    tax_code_snapshot: { type: 'text' },
    tax_treatment_snapshot: { type: 'text' },
    deductible_percent_snapshot: { type: 'numeric(5,2)', notNull: true, default: 100 },
    tax_legal_note: { type: 'text' },
  });
  pgm.addColumns('purchase_invoice_lines', {
    tax_code_snapshot: { type: 'text' },
    tax_treatment_snapshot: { type: 'text' },
    deductible_percent_snapshot: { type: 'numeric(5,2)', notNull: true, default: 100 },
    tax_legal_note: { type: 'text' },
  });

  // -------------------------------------------------------------------------
  // 4. Permissions
  // -------------------------------------------------------------------------
  for (const [key, description] of [
    ['tax.read', 'Read tax codes'],
    ['tax.manage', 'Manage tax codes'],
    ['tax.report.read', 'Read VAT reports'],
  ]) {
    pgm.sql(`INSERT INTO permissions (key, description) VALUES ('${key}', '${description}') ON CONFLICT (key) DO NOTHING`);
  }
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r CROSS JOIN permissions p
    WHERE r.name IN ('Owner', 'Admin')
      AND p.key IN ('tax.read', 'tax.manage', 'tax.report.read')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r CROSS JOIN permissions p
    WHERE r.name = 'Accountant'
      AND p.key IN ('tax.read', 'tax.report.read')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r CROSS JOIN permissions p
    WHERE r.name IN ('Viewer', 'Employee')
      AND p.key IN ('tax.read')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);

  // -------------------------------------------------------------------------
  // 5. Statutory seed (idempotent, existing tenants only)
  // -------------------------------------------------------------------------
  for (const row of SEED) {
    const legal = JSON.stringify(row[14]);
    pgm.sql(`
      INSERT INTO tax_codes
        (tenant_id, code, name, country_code, rate, type, effective_from, effective_to,
         reporting_mapping, is_active, direction, treatment, reverse_charge, intra_eu,
         is_export, is_import, deductible_percent, legal_notes, is_system)
      SELECT t.id,
             '${sqlEscape(row[0])}',
             '${sqlEscape(row[1])}',
             'FI',
             ${sqlEscape(row[2])},
             '${sqlEscape(row[3])}',
             '${sqlEscape(row[6])}'::date,
             ${row[7] ? `'${sqlEscape(row[7])}'::date` : 'NULL'},
             '${sqlEscape(row[8])}',
             true,
             '${sqlEscape(row[5])}',
             '${sqlEscape(row[4])}',
             ${row[10] === true},
             ${row[11] === true},
             ${row[12] === true},
             ${row[13] === true},
             '${sqlEscape(row[9])}',
             '${sqlEscape(legal)}'::jsonb,
             true
      FROM tenants t
      WHERE NOT EXISTS (
        SELECT 1 FROM tax_codes tc
        WHERE tc.tenant_id = t.id AND tc.code = '${sqlEscape(row[0])}'
          AND tc.effective_from = '${sqlEscape(row[6])}'::date
      )
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM role_permissions rp USING permissions p
    WHERE rp.permission_id = p.id AND p.key IN ('tax.read', 'tax.manage', 'tax.report.read')
  `);
  pgm.sql(`DELETE FROM permissions WHERE key IN ('tax.read', 'tax.manage', 'tax.report.read')`);
  pgm.sql(`DELETE FROM tax_codes WHERE is_system = true`);
  pgm.dropColumns('purchase_invoice_lines', [
    'tax_code_snapshot',
    'tax_treatment_snapshot',
    'deductible_percent_snapshot',
    'tax_legal_note',
  ]);
  pgm.dropColumns('sales_invoice_lines', [
    'tax_code_snapshot',
    'tax_treatment_snapshot',
    'deductible_percent_snapshot',
    'tax_legal_note',
  ]);
  pgm.dropColumns('journal_lines', [
    'tax_code_snapshot',
    'tax_treatment_snapshot',
    'taxable_base_snapshot',
    'tax_amount_snapshot',
    'tax_deductible_snapshot',
    'tax_nondeductible_snapshot',
    'tax_leg_type',
    'tax_reporting_classification',
    'tax_legal_note',
  ]);
  pgm.dropIndex('journal_lines', ['tenant_id', 'tax_code_id']);
  pgm.sql('DROP INDEX IF EXISTS journal_lines_tax_reporting_classification_idx');
  pgm.dropConstraint('tax_codes', 'tax_codes_direction_check');
  pgm.dropConstraint('tax_codes', 'tax_codes_treatment_check');
  pgm.dropConstraint('tax_codes', 'tax_codes_deductible_check');
  pgm.dropIndex('tax_codes', ['tenant_id', 'direction', 'is_active', 'treatment']);
  pgm.dropIndex('tax_codes', ['tenant_id', 'country_code', 'effective_from']);
  pgm.dropColumns('tax_codes', [
    'direction',
    'treatment',
    'reverse_charge',
    'intra_eu',
    'is_export',
    'is_import',
    'deductible_percent',
    'legal_notes',
    'is_system',
  ]);
};
