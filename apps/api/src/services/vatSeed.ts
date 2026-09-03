import type { DbClient } from '../db/pool';
import {
  TAX_TREATMENTS,
  type TaxDirection,
  type TaxTreatment,
} from './vatEngineService';

/**
 * Default Finnish statutory tax codes.
 *
 * Source of the rates and legal wording:
 * - vero.fi Rates of VAT (checked 2026-09-03)
 * - vero.fi VAT reverse charge in the construction sector (checked
 *   2026-09-03; § 8 c of the Finnish Value Added Tax Act / Art. 199 of
 *   Directive 2006/112/EC)
 * - vero.fi Intra-Community trade (checked 2026-09-03)
 * - vero.fi Value-added taxation of cross-border supply and acquisition of
 *   services (record VH/4150/00.01.00/2021, checked 2026-09-03)
 *
 * Rate history is stored as dated rows of the same stable code, so old
 * documents select the version that was in force on their transaction date.
 */

export interface VatSeedDefinition {
  code: string;
  name: string;
  rate: string;
  legacyType: string;
  treatment: TaxTreatment;
  direction: TaxDirection;
  effectiveFrom: string;
  effectiveTo?: string | null;
  reporting: string;
  deductible: string;
  reverseCharge?: boolean;
  intraEu?: boolean;
  exportFlag?: boolean;
  importFlag?: boolean;
  legalNotes: Record<string, string>;
}

const RC_CONSTRUCTION_NOTES = {
  fi: 'Lasku ei sisällä arvonlisäveroa. Rakennusalan käännetty verovelvollisuus: ostaja on verovelvollinen maksamaan arvonlisäveron (AVL 8 c § / direktiivin 2006/112/EY 199 artikla). Ostajan Y-tunnus: {buyer_id}',
  en: 'This invoice does not include VAT. VAT reverse charge in the construction sector: the buyer is liable to pay the VAT (Section 8 c of the Finnish Value Added Tax Act / Article 199 of Directive 2006/112/EC). Buyer Business ID: {buyer_id}',
  et: 'Arve ei sisalda käibemaksu. Ehitussektori pöördmaksustamine: ostja on kohustatud tasuma käibemaksu (AVL § 8 c / direktiivi 2006/112/EÜ artikkel 199). Ostja registrikood: {buyer_id}',
};

const EU_GOODS_NOTES = {
  fi: 'VAT 0 %, yhteisömyynti (AVL 72 a §). Ostajan ALV-tunnus: {vat_id}',
  en: 'VAT 0%, intra-Community supply. Buyer VAT number: {vat_id}',
  et: 'KM 0%, ühendusesisene müük. Ostja käibemaksukohustuslase number: {vat_id}',
};

const EU_SERVICE_NOTES = {
  fi: 'VAT 0 %, käännetty verovelvollisuus. Palvelu myydään yritysasiakkaalle toiseen EU-maahan; verokohtelu määräytyy ostajan sijoittautumismaan mukaan (AVL 65 §). Ostajan ALV-tunnus: {vat_id}',
  en: 'VAT 0%, reverse charge. Service supplied to a VAT-registered business in another EU Member State; place of supply is where the customer is established. Buyer VAT number: {vat_id}',
  et: 'KM 0%, pöördmaksustamine. Teenus osutatakse teises ELi liikmesriigis asuvale ettevõtjast kliendile; maksustamiskoht on kliendi asukohariik. Ostja käibemaksukohustuslase number: {vat_id}',
};

const EXPORT_NOTES = {
  fi: 'VAT 0 % — vienti EU:n ulkopuolelle.',
  en: 'VAT 0% — export outside the EU.',
  et: 'KM 0% — eksport väljapoole ELi.',
};

const EXEMPT_NOTES = {
  fi: 'Arvonlisäveroton myynti.',
  en: 'VAT exempt supply.',
  et: 'Käibemaksuvaba müük.',
};

const RC_PURCHASE_NOTES = {
  fi: 'Käännetty verovelvollisuus: ostaja ilmoittaa ja maksaa arvonlisäveron.',
  en: 'Reverse charge: the buyer reports and pays the VAT.',
  et: 'Pöördmaksustamine: ostja deklareerib ja tasub käibemaksu.',
};

const ACQUISITION_NOTES = {
  fi: 'Yhteisöhankinta / käännetty verovelvollisuus: ostaja ilmoittaa ja maksaa arvonlisäveron Suomessa.',
  en: 'Intra-Community acquisition / reverse charge: the buyer reports and pays Finnish VAT.',
  et: 'Ühendusesisene soetamine / pöördmaksustamine: ostja deklareerib ja tasub Soome käibemaksu.',
};

const IMPORT_NOTES = {
  fi: 'Tuontivero: tuonnin arvonlisävero ilmoitetaan ja vähennetään verokaudella.',
  en: 'Import VAT: import VAT is reported and deducted for the tax period when the deduction right applies.',
  et: 'Impordikäibemaks: impordikäibemaks deklareeritakse ja arvatakse maha, kui mahaarvamisõigus kehtib.',
};

export const DEFAULT_FI_TAX_CODES: VatSeedDefinition[] = [
  // Standard VAT history (24% until 31 Aug 2024, 25.5% from 1 Sep 2024).
  {
    code: 'FI_SALES_STD', name: 'Finnish standard VAT 24 %', rate: '24',
    legacyType: 'VAT', treatment: TAX_TREATMENTS.STANDARD, direction: 'SALES',
    effectiveFrom: '2013-01-01', effectiveTo: '2024-08-31',
    reporting: 'DOMESTIC_OUTPUT_VAT', deductible: '100', legalNotes: {},
  },
  {
    code: 'FI_SALES_STD', name: 'Finnish standard VAT 25.5 %', rate: '25.5',
    legacyType: 'VAT', treatment: TAX_TREATMENTS.STANDARD, direction: 'SALES',
    effectiveFrom: '2024-09-01', effectiveTo: null,
    reporting: 'DOMESTIC_OUTPUT_VAT', deductible: '100', legalNotes: {},
  },
  {
    code: 'FI_PURCHASE_STD', name: 'Finnish standard VAT 24 % (purchase)', rate: '24',
    legacyType: 'VAT', treatment: TAX_TREATMENTS.STANDARD, direction: 'PURCHASE',
    effectiveFrom: '2013-01-01', effectiveTo: '2024-08-31',
    reporting: 'DOMESTIC_INPUT_VAT', deductible: '100', legalNotes: {},
  },
  {
    code: 'FI_PURCHASE_STD', name: 'Finnish standard VAT 25.5 % (purchase)', rate: '25.5',
    legacyType: 'VAT', treatment: TAX_TREATMENTS.STANDARD, direction: 'PURCHASE',
    effectiveFrom: '2024-09-01', effectiveTo: null,
    reporting: 'DOMESTIC_INPUT_VAT', deductible: '100', legalNotes: {},
  },
  // Main reduced rate history (14% until 31 Dec 2025, 13.5% from 1 Jan 2026).
  {
    code: 'FI_SALES_REDUCED_MAIN', name: 'Finnish reduced VAT 14 %', rate: '14',
    legacyType: 'VAT', treatment: TAX_TREATMENTS.REDUCED, direction: 'SALES',
    effectiveFrom: '2013-01-01', effectiveTo: '2025-12-31',
    reporting: 'DOMESTIC_OUTPUT_VAT', deductible: '100', legalNotes: {},
  },
  {
    code: 'FI_SALES_REDUCED_MAIN', name: 'Finnish reduced VAT 13.5 %', rate: '13.5',
    legacyType: 'VAT', treatment: TAX_TREATMENTS.REDUCED, direction: 'SALES',
    effectiveFrom: '2026-01-01', effectiveTo: null,
    reporting: 'DOMESTIC_OUTPUT_VAT', deductible: '100', legalNotes: {},
  },
  {
    code: 'FI_PURCHASE_REDUCED_MAIN', name: 'Finnish reduced VAT 14 % (purchase)', rate: '14',
    legacyType: 'VAT', treatment: TAX_TREATMENTS.REDUCED, direction: 'PURCHASE',
    effectiveFrom: '2013-01-01', effectiveTo: '2025-12-31',
    reporting: 'DOMESTIC_INPUT_VAT', deductible: '100', legalNotes: {},
  },
  {
    code: 'FI_PURCHASE_REDUCED_MAIN', name: 'Finnish reduced VAT 13.5 % (purchase)', rate: '13.5',
    legacyType: 'VAT', treatment: TAX_TREATMENTS.REDUCED, direction: 'PURCHASE',
    effectiveFrom: '2026-01-01', effectiveTo: null,
    reporting: 'DOMESTIC_INPUT_VAT', deductible: '100', legalNotes: {},
  },
  // 10 % reduced rate (newspapers and magazines from 2025; 2013 start keeps
  // the code valid for the historical 10 % category).
  {
    code: 'FI_SALES_REDUCED_10', name: 'Finnish reduced VAT 10 %', rate: '10',
    legacyType: 'VAT', treatment: TAX_TREATMENTS.REDUCED, direction: 'SALES',
    effectiveFrom: '2013-01-01', effectiveTo: null,
    reporting: 'DOMESTIC_OUTPUT_VAT', deductible: '100', legalNotes: {},
  },
  {
    code: 'FI_PURCHASE_REDUCED_10', name: 'Finnish reduced VAT 10 % (purchase)', rate: '10',
    legacyType: 'VAT', treatment: TAX_TREATMENTS.REDUCED, direction: 'PURCHASE',
    effectiveFrom: '2013-01-01', effectiveTo: null,
    reporting: 'DOMESTIC_INPUT_VAT', deductible: '100', legalNotes: {},
  },
  // 0 %, exempt, EU, export, import and reverse-charge treatments.
  {
    code: 'FI_SALES_ZERO', name: 'Taxable sale at 0 %', rate: '0',
    legacyType: 'ZERO', treatment: TAX_TREATMENTS.ZERO_RATED, direction: 'SALES',
    effectiveFrom: '2013-01-01', effectiveTo: null,
    reporting: 'ZERO_RATED', deductible: '100', legalNotes: {},
  },
  {
    code: 'FI_SALES_EXEMPT', name: 'VAT-exempt sale', rate: '0',
    legacyType: 'EXEMPT', treatment: TAX_TREATMENTS.EXEMPT, direction: 'SALES',
    effectiveFrom: '2013-01-01', effectiveTo: null,
    reporting: 'EXEMPT', deductible: '100', legalNotes: EXEMPT_NOTES,
  },
  {
    code: 'FI_PURCHASE_EXEMPT', name: 'VAT-exempt purchase', rate: '0',
    legacyType: 'EXEMPT', treatment: TAX_TREATMENTS.EXEMPT, direction: 'PURCHASE',
    effectiveFrom: '2013-01-01', effectiveTo: null,
    reporting: 'EXEMPT', deductible: '0', legalNotes: {},
  },
  {
    code: 'FI_EU_GOODS_SALE', name: 'Intra-EU B2B goods sale', rate: '0',
    legacyType: 'ZERO', treatment: TAX_TREATMENTS.EU_GOODS_SUPPLY, direction: 'SALES',
    effectiveFrom: '2013-01-01', effectiveTo: null,
    reporting: 'EU_GOODS_SUPPLY', deductible: '100', intraEu: true,
    legalNotes: EU_GOODS_NOTES,
  },
  {
    code: 'FI_EU_GOODS_PURCHASE', name: 'Intra-EU B2B goods acquisition', rate: '25.5',
    legacyType: 'VAT', treatment: TAX_TREATMENTS.EU_GOODS_ACQUISITION, direction: 'PURCHASE',
    effectiveFrom: '2024-09-01', effectiveTo: null,
    reporting: 'EU_GOODS_ACQUISITION', deductible: '100', intraEu: true,
    legalNotes: ACQUISITION_NOTES,
  },
  {
    code: 'FI_EU_SERVICE_SALE', name: 'Intra-EU B2B service sale', rate: '0',
    legacyType: 'ZERO', treatment: TAX_TREATMENTS.EU_SERVICE_SUPPLY, direction: 'SALES',
    effectiveFrom: '2013-01-01', effectiveTo: null,
    reporting: 'EU_SERVICES_SUPPLY', deductible: '100', intraEu: true,
    legalNotes: EU_SERVICE_NOTES,
  },
  {
    code: 'FI_EU_SERVICE_PURCHASE', name: 'Intra-EU B2B service acquisition', rate: '25.5',
    legacyType: 'VAT', treatment: TAX_TREATMENTS.EU_SERVICE_ACQUISITION, direction: 'PURCHASE',
    effectiveFrom: '2024-09-01', effectiveTo: null,
    reporting: 'EU_SERVICES_ACQUISITION', deductible: '100', intraEu: true,
    legalNotes: ACQUISITION_NOTES,
  },
  {
    code: 'FI_EXPORT', name: 'Export outside the EU', rate: '0',
    legacyType: 'ZERO', treatment: TAX_TREATMENTS.EXPORT, direction: 'SALES',
    effectiveFrom: '2013-01-01', effectiveTo: null,
    reporting: 'EXPORT', deductible: '100', exportFlag: true,
    legalNotes: EXPORT_NOTES,
  },
  {
    code: 'FI_IMPORT', name: 'Import VAT (self-assessed)', rate: '25.5',
    legacyType: 'VAT', treatment: TAX_TREATMENTS.IMPORT, direction: 'PURCHASE',
    effectiveFrom: '2024-09-01', effectiveTo: null,
    reporting: 'IMPORT', deductible: '100', importFlag: true,
    legalNotes: IMPORT_NOTES,
  },
  {
    code: 'FI_RC_PURCHASE', name: 'Reverse-charge purchase', rate: '25.5',
    legacyType: 'REVERSE_CHARGE', treatment: TAX_TREATMENTS.REVERSE_CHARGE, direction: 'PURCHASE',
    effectiveFrom: '2024-09-01', effectiveTo: null,
    reporting: 'REVERSE_CHARGE', deductible: '100', reverseCharge: true,
    legalNotes: RC_PURCHASE_NOTES,
  },
  {
    code: 'FI_CONSTRUCTION_RC_SALE', name: 'Construction reverse-charge sale', rate: '0',
    legacyType: 'REVERSE_CHARGE', treatment: TAX_TREATMENTS.CONSTRUCTION_REVERSE_CHARGE,
    direction: 'SALES', effectiveFrom: '2024-09-01', effectiveTo: null,
    reporting: 'CONSTRUCTION_RC', deductible: '100', reverseCharge: true,
    legalNotes: RC_CONSTRUCTION_NOTES,
  },
  {
    code: 'FI_CONSTRUCTION_RC_PURCHASE', name: 'Construction reverse-charge purchase', rate: '25.5',
    legacyType: 'REVERSE_CHARGE', treatment: TAX_TREATMENTS.CONSTRUCTION_REVERSE_CHARGE,
    direction: 'PURCHASE', effectiveFrom: '2024-09-01', effectiveTo: null,
    reporting: 'CONSTRUCTION_RC', deductible: '100', reverseCharge: true,
    legalNotes: RC_PURCHASE_NOTES,
  },
];

/**
 * Idempotent seed for a tenant. Called during tenant creation and by the
 * v0.9 migration for existing tenants. Statutory codes are flagged
 * `is_system = true` so the API can protect them from casual edits.
 */
export async function seedDefaultFiTaxCodes(client: DbClient, tenantId: string): Promise<void> {
  for (const row of DEFAULT_FI_TAX_CODES) {
    const legal = JSON.stringify(row.legalNotes);
    await client.query(
      `INSERT INTO tax_codes
         (tenant_id, code, name, country_code, rate, type, effective_from, effective_to,
          reporting_mapping, is_active, direction, treatment, reverse_charge, intra_eu,
          is_export, is_import, deductible_percent, legal_notes, is_system)
       VALUES ($1, $2, $3, 'FI', $4, $5, $6::date, $7::date, $8, true, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, true)
       ON CONFLICT (tenant_id, code, effective_from) DO NOTHING`,
      [
        tenantId,
        row.code,
        row.name,
        row.rate,
        row.legacyType,
        row.effectiveFrom,
        row.effectiveTo ?? null,
        row.reporting,
        row.direction,
        row.treatment,
        row.reverseCharge === true,
        row.intraEu === true,
        row.exportFlag === true,
        row.importFlag === true,
        row.deductible,
        legal,
      ],
    );
  }
}

/**
 * Returns the current code list shape used by the migration. Kept as a
 * comment-only mirror here; the migration file carries the canonical SQL.
 */
export const seedCount = DEFAULT_FI_TAX_CODES.length;
