import type { AppConfig } from '../config/env';
import type { Db } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import { isValidFinnishBusinessId, normalizeFinnishBusinessId } from '../lib/businessId';
import type { BusinessRegistryProvider } from './businessRegistryProvider';
import type { RegistryCompany } from './businessRegistryTypes';

export type RegistryLookupKind = 'BUSINESS_ID' | 'NAME';

export interface RegistrySearchInput {
  query: string;
  limit?: number;
}

export interface RegistrySearchResult {
  query: string;
  provider: string;
  searched_by: RegistryLookupKind;
  results: RegistryCompany[];
  total: number;
  from_cache: boolean;
}

export interface RegistryContext {
  tenantId: string;
  userId: string;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_CLEANUP_INTERVAL = 120_000;

/**
 * Orchestrates provider lookups for the application. Responsibilities:
 *  - Business ID detection/normalization/validation before any network call;
 *  - DB-backed provider cache (positive + negative) with a configurable TTL;
 *  - application-level sliding window that protects the external provider
 *    from button spam and accidental loops.
 */
export class BusinessRegistryService {
  private readonly recentProviderCalls = new Map<string, number[]>();

  constructor(
    private readonly pool: Db,
    private readonly provider: BusinessRegistryProvider,
    private readonly config: AppConfig,
  ) {}

  isEnabled(): boolean {
    return this.config.BUSINESS_REGISTRY_ENABLED;
  }

  async search(input: RegistrySearchInput, context: RegistryContext): Promise<RegistrySearchResult> {
    const query = String(input.query ?? '').trim();
    if (!query) {
      throw new AppError(ErrorCodes.invalidRequest, 'Search query is required', 400);
    }
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const canonical = normalizeFinnishBusinessId(query);

    if (canonical) {
      if (!isValidFinnishBusinessId(canonical)) {
        throw new AppError(
          ErrorCodes.registryInvalidBusinessId,
          'Check the Business ID and try again',
          400,
        );
      }
      const lookup = await this.lookupByBusinessId(canonical, context, limit);
      return {
        query,
        provider: this.provider.name,
        searched_by: 'BUSINESS_ID',
        results: lookup.companies,
        total: lookup.companies.length,
        from_cache: lookup.fromCache,
      };
    }

    if (query.length < 2) {
      throw new AppError(ErrorCodes.invalidRequest, 'Search query must be at least 2 characters', 400);
    }
    const lookup = await this.lookupByName(query, context, limit);
    return {
      query,
      provider: this.provider.name,
      searched_by: 'NAME',
      results: lookup.companies,
      total: lookup.companies.length,
      from_cache: lookup.fromCache,
    };
  }

  async getByBusinessId(businessId: string, context: RegistryContext): Promise<RegistryCompany | null> {
    const canonical = normalizeFinnishBusinessId(businessId);
    if (!canonical || !isValidFinnishBusinessId(canonical)) {
      throw new AppError(
        ErrorCodes.registryInvalidBusinessId,
        'Check the Business ID and try again',
        400,
      );
    }
    const lookup = await this.lookupByBusinessId(canonical, context, 1);
    return lookup.companies[0] ?? null;
  }

  private async lookupByBusinessId(
    businessId: string,
    context: RegistryContext,
    limit: number,
  ): Promise<{ companies: RegistryCompany[]; fromCache: boolean }> {
    this.ensureEnabled();
    const cached = await this.readCache('BUSINESS_ID', businessId);
    if (cached) return { companies: cached.slice(0, limit), fromCache: true };
    this.assertRateLimit(context);
    const company = await this.provider.getByBusinessId(businessId);
    const companies = company ? [company] : [];
    await this.writeCache('BUSINESS_ID', businessId, companies);
    return { companies, fromCache: false };
  }

  private async lookupByName(
    query: string,
    context: RegistryContext,
    limit: number,
  ): Promise<{ companies: RegistryCompany[]; fromCache: boolean }> {
    this.ensureEnabled();
    const cacheKey = query.trim().toLowerCase().replace(/\s+/g, ' ');
    const cached = await this.readCache('NAME', cacheKey);
    if (cached) return { companies: cached.slice(0, limit), fromCache: true };
    this.assertRateLimit(context);
    const companies = await this.provider.searchByName({ query, limit });
    await this.writeCache('NAME', cacheKey, companies);
    return { companies, fromCache: false };
  }

  private ensureEnabled(): void {
    if (!this.config.BUSINESS_REGISTRY_ENABLED) {
      throw new AppError(
        ErrorCodes.registryDisabled,
        'Business registry service is disabled',
        503,
      );
    }
  }

  private async readCache(
    type: RegistryLookupKind,
    key: string,
  ): Promise<RegistryCompany[] | null> {
    const result = await this.pool.query(
      `SELECT payload, fetched_at
       FROM business_registry_cache
       WHERE provider = $1 AND lookup_type = $2 AND lookup_key = $3`,
      [this.provider.name, type, key],
    );
    const row = result.rows[0];
    if (!row?.payload) return null;
    const fetchedAt = new Date(String(row.fetched_at)).getTime();
    const ttlMs = this.config.BUSINESS_REGISTRY_CACHE_TTL_SECONDS * 1000;
    if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > ttlMs) return null;
    const payload = row.payload;
    if (!Array.isArray(payload)) return null;
    return payload as RegistryCompany[];
  }

  private async writeCache(type: RegistryLookupKind, key: string, companies: RegistryCompany[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO business_registry_cache
         (provider, lookup_type, lookup_key, payload, fetched_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (provider, lookup_type, lookup_key)
       DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
      [this.provider.name, type, key, JSON.stringify(companies)],
    );
  }

  private assertRateLimit(context: RegistryContext): void {
    const now = Date.now();
    const key = `${this.provider.name}:${context.tenantId}:${context.userId}`;
    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    const calls = (this.recentProviderCalls.get(key) ?? []).filter((ts) => ts > windowStart);
    const max = this.config.BUSINESS_REGISTRY_RATE_LIMIT_PER_MINUTE;
    if (calls.length >= max) {
      throw new AppError(
        ErrorCodes.registryRateLimited,
        'Too many searches. Please wait a moment.',
        429,
      );
    }
    calls.push(now);
    this.recentProviderCalls.set(key, calls);
    if (this.recentProviderCalls.size > 10_000) {
      const cutoff = now - RATE_LIMIT_CLEANUP_INTERVAL;
      for (const [candidateKey, timestamps] of this.recentProviderCalls) {
        if (timestamps[timestamps.length - 1]! < cutoff) {
          this.recentProviderCalls.delete(candidateKey);
        }
      }
    }
  }
}
