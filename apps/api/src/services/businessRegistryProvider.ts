import type { RegistryCompany } from './businessRegistryTypes';

/**
 * Country/provider neutral registry adapter. UI and services only ever speak
 * to this interface; a future Estonian (Äriregister) or Swedish (Bolagsverket)
 * adapter can be added without touching customer/supplier flows.
 */
export interface BusinessRegistryProvider {
  readonly name: string;

  /**
   * Partial company name search. Returns normalized companies sorted by the
   * provider's own relevance.
   */
  searchByName(options: { query: string; limit?: number }): Promise<RegistryCompany[]>;

  /**
   * Exact lookup by canonical Finnish Business ID (NNNNNNN-N). Returns null
   * when the identifier is valid but not found.
   */
  getByBusinessId(businessId: string): Promise<RegistryCompany | null>;
}
