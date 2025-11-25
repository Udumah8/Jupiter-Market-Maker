/**
 * Enhanced Birdeye Price Feed with public endpoint fallback and status tracking
 * Uses official /public/price endpoint with enhanced monitoring and fallback capabilities
 */

import { PublicKey } from '@solana/web3.js';
import { Logger } from '../../utils/Logger.js';
import { RateLimiter } from '../../utils/RateLimiter.js';
import { PriceFeedError } from '../errors/PriceFeedError.js';

interface BirdeyePriceResponse {
  success: boolean;
  data?: {
    value: number;
    updateUnixTime: number;
    updateHumanTime: string;
  };
}

interface EndpointStatus {
  endpoint: string;
  url: string;
  lastSuccess?: number;
  lastFailure?: number;
  consecutiveFailures: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  lastRequestTime?: number;
  requiresAuth: boolean;
  isFallback: boolean;
}

export class BirdeyePriceFeed {
  private logger: Logger;
  private baseUrl = 'https://public-api.birdeye.so';
  private apiKey?: string;
  private endpointStatuses: Map<string, EndpointStatus> = new Map();
  private rateLimiter: RateLimiter;

  // Simple in-memory cache (token -> { usdPrice, timestamp })
  private priceCache = new Map<string, { price: number; ts: number }>();
  private cacheTTL = 4_000; // 4 seconds (Birdeye updates ~every 1-5s)

  constructor(logger: Logger, apiKey?: string) {
    this.logger = logger;
    this.apiKey = apiKey || process.env.BIRDEYE_API_KEY;

    this.rateLimiter = new RateLimiter({
      maxRequests: 10, // Birdeye public API limit
      windowMs: 1000,
    });

    // Initialize endpoint statuses
    const authenticatedEndpoint = this.initializeEndpointStatus('authenticated', `${this.baseUrl}/defi/price`, false, true);
    const publicEndpoint = this.initializeEndpointStatus('public', `${this.baseUrl}/defi/price`, false, false);

    this.endpointStatuses.set('authenticated', authenticatedEndpoint);
    this.endpointStatuses.set('public', publicEndpoint);

    if (!this.apiKey) {
      this.logger.warn('Birdeye API key not provided - using free tier (very limited)', {
        fallbackEnabled: true,
      });
    } else {
      this.logger.info('BirdeyePriceFeed initialized with API key support', {
        hasApiKey: true,
        fallbackEnabled: true,
      });
    }
  }

  /**
   * Get price from Birdeye with enhanced fallback logic
   */
  async getPrice(baseMint: PublicKey, quoteMint: PublicKey): Promise<number | null> {
    const startTime = Date.now();
    const baseStr = baseMint.toBase58();
    const quoteStr = quoteMint.toBase58();

    try {
      // Try authenticated endpoint first if API key is available
      if (this.apiKey) {
        this.logger.debug('Attempting Birdeye price fetch via authenticated endpoint', {
          base: baseStr,
          quote: quoteStr,
          endpoint: 'authenticated',
          hasApiKey: true,
        });

        const price = await this.fetchTokenPriceUSD(baseStr, 'authenticated');
        if (price !== null) {
          this.recordSuccess('authenticated', Date.now() - startTime);
          this.logger.info('Successfully fetched Birdeye price via authenticated endpoint', {
            base: baseStr,
            quote: quoteStr,
            price,
            responseTime: Date.now() - startTime,
          });
          return price;
        }
      }

      // Fallback to public endpoint if authenticated fails or no API key
      this.logger.warn('Falling back to public endpoint', {
        base: baseStr,
        quote: quoteStr,
        fallbackReason: this.apiKey ? 'Authenticated endpoint failed' : 'No API key provided',
        endpoint: 'public',
      });

      const price = await this.fetchTokenPriceUSD(baseStr, 'public');
      if (price !== null) {
        this.recordSuccess('public', Date.now() - startTime);
        this.logger.info('Successfully fetched Birdeye price via public endpoint (fallback)', {
          base: baseStr,
          quote: quoteStr,
          price,
          responseTime: Date.now() - startTime,
          isFallback: true,
        });
        return price;
      }

      return null;

    } catch (error) {
      const responseTime = Date.now() - startTime;

      // Record failure for the attempted endpoint(s)
      if (this.apiKey) {
        this.recordFailure('authenticated', responseTime);
      }
      this.recordFailure('public', responseTime);

      this.logger.error('Birdeye price fetch failed from all endpoints', {
        base: baseStr,
        quote: quoteStr,
        error: error instanceof Error ? error.message : 'Unknown error',
        responseTime,
        attemptedEndpoints: this.apiKey ? ['authenticated', 'public'] : ['public'],
      });

      return null;
    }
  }

  /**
   * Get endpoint status for monitoring and diagnostics
   */
  getEndpointStatus(endpoint: 'authenticated' | 'public'): EndpointStatus | null {
    return this.endpointStatuses.get(endpoint) || null;
  }

  /**
   * Get overall Birdeye feed health status
   */
  getOverallStatus(): {
    isHealthy: boolean;
    authenticatedEndpointHealthy: boolean;
    publicEndpointHealthy: boolean;
    hasApiKey: boolean;
    totalRequests: number;
    overallSuccessRate: number;
    lastActivity?: number;
  } {
    const authStatus = this.endpointStatuses.get('authenticated');
    const publicStatus = this.endpointStatuses.get('public');

    const totalRequests = (authStatus?.totalRequests || 0) + (publicStatus?.totalRequests || 0);
    const totalSuccesses = (authStatus?.successfulRequests || 0) + (publicStatus?.successfulRequests || 0);

    return {
      isHealthy: totalRequests > 0 && (totalSuccesses / totalRequests) > 0.3, // More lenient for public endpoint
      authenticatedEndpointHealthy: this.isEndpointHealthy('authenticated'),
      publicEndpointHealthy: this.isEndpointHealthy('public'),
      hasApiKey: !!this.apiKey,
      totalRequests,
      overallSuccessRate: totalRequests > 0 ? totalSuccesses / totalRequests : 0,
      lastActivity: Math.max(
        authStatus?.lastRequestTime || 0,
        publicStatus?.lastRequestTime || 0
      ),
    };
  }

  /**
   * Fetch token price USD from specific endpoint
   */
  private async fetchTokenPriceUSD(mint: string, endpoint: 'authenticated' | 'public'): Promise<number | null> {
    const startTime = Date.now();
    const cacheKey = `${mint}_${endpoint}`;
    const cached = this.priceCache.get(cacheKey);

    if (cached && Date.now() - cached.ts < this.cacheTTL) {
      return cached.price;
    }

    try {
      this.recordRequest(endpoint);

      const response = await this.rateLimiter.execute(async () => {
        return fetch(
          `${this.baseUrl}/defi/price?address=${mint}`,
          {
            headers: {
              'accept': 'application/json',
              'x-chain': 'solana',
              ...(endpoint === 'authenticated' && this.apiKey && { 'X-API-KEY': this.apiKey }),
            },
          }
        );
      });

      const responseTime = Date.now() - startTime;

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          // Authentication error - this is expected for public endpoint
          if (endpoint === 'authenticated') {
            this.recordFailure(endpoint, responseTime);
            throw PriceFeedError.fromHttpResponse('birdeye', response.status, 'Authentication failed', `${this.baseUrl}/defi/price`);
          }
        }

        this.recordFailure(endpoint, responseTime);

        if (response.status === 429) {
          throw PriceFeedError.fromHttpResponse('birdeye', response.status, 'Rate limit exceeded', `${this.baseUrl}/defi/price`);
        }

        throw PriceFeedError.fromHttpResponse('birdeye', response.status, await response.text(), `${this.baseUrl}/defi/price`);
      }

      const json = (await response.json()) as BirdeyePriceResponse;

      if (!json.success || !json.data?.value || json.data.value <= 0) {
        this.recordFailure(endpoint, responseTime);
        throw PriceFeedError.fromNoData('birdeye', mint, 'Invalid or missing price data in response');
      }

      const price = json.data.value;
      this.priceCache.set(cacheKey, { price, ts: Date.now() });

      this.logger.debug('Successfully fetched Birdeye token price', {
        mint,
        price,
        endpoint,
        isFallback: endpoint === 'public',
        responseTime,
      });

      return price;

    } catch (error) {
      // const responseTime = Date.now() - startTime; // Unused - response time tracked in retry manager

      if (error instanceof PriceFeedError) {
        throw error; // Re-throw our custom errors
      }

      // Convert unknown errors to network errors
      throw PriceFeedError.fromNetworkError('birdeye', error instanceof Error ? error : 'Unknown error', `${endpoint} endpoint request`);
    }
  }

  /**
   * Initialize endpoint status tracking
   */
  private initializeEndpointStatus(endpoint: string, url: string, requiresAuth: boolean, isFallback: boolean): EndpointStatus {
    return {
      endpoint,
      url,
      consecutiveFailures: 0,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
      requiresAuth,
      isFallback,
    };
  }

  /**
   * Record a request attempt
   */
  private recordRequest(endpoint: string): void {
    const status = this.endpointStatuses.get(endpoint);
    if (status) {
      status.totalRequests++;
      status.lastRequestTime = Date.now();
    }
  }

  /**
   * Record a successful request
   */
  private recordSuccess(endpoint: string, responseTime: number): void {
    const status = this.endpointStatuses.get(endpoint);
    if (status) {
      status.successfulRequests++;
      status.consecutiveFailures = 0; // Reset failure streak
      status.lastSuccess = Date.now();

      // Update average response time (exponential moving average)
      const alpha = 0.1; // Smoothing factor
      status.averageResponseTime =
        status.averageResponseTime === 0
          ? responseTime
          : (alpha * responseTime + (1 - alpha) * status.averageResponseTime);
    }
  }

  /**
   * Record a failed request
   */
  private recordFailure(endpoint: string, responseTime: number): void {
    const status = this.endpointStatuses.get(endpoint);
    if (status) {
      status.failedRequests++;
      status.consecutiveFailures++;
      status.lastFailure = Date.now();

      // Update average response time even for failures
      const alpha = 0.1; // Smoothing factor
      status.averageResponseTime =
        status.averageResponseTime === 0
          ? responseTime
          : (alpha * responseTime + (1 - alpha) * status.averageResponseTime);
    }
  }

  /**
   * Check if an endpoint is considered healthy
   */
  private isEndpointHealthy(endpoint: string): boolean {
    const status = this.endpointStatuses.get(endpoint);
    if (!status) return false;

    // More lenient for public endpoint as it has limitations
    const successRateThreshold = endpoint === 'public' ? 0.2 : 0.5;

    return status.consecutiveFailures < 5 &&
      (status.totalRequests === 0 || status.successfulRequests / status.totalRequests > successRateThreshold);
  }

  /**
   * Clear price cache
   */
  clearCache(): void {
    this.priceCache.clear();
  }
}
