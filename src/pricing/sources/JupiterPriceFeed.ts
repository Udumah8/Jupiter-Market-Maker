/**
 * Jupiter Price Feed - Price API V3 (Lite + Pro Compatible)
 * 
 * Enhanced version with:
 * - Robust error handling and connection timeout detection
 * - Endpoint health tracking
 * - Rate limiting
 * - Fallback logic for network failures
 * - Integration with existing logging infrastructure
 * 
 * Based on: https://dev.jup.ag/docs/price/v3
 */

import { PublicKey } from '@solana/web3.js';
import { Logger } from '../../utils/Logger.js';
import { RateLimiter } from '../../utils/RateLimiter.js';
import { PriceFeedError } from '../errors/PriceFeedError.js';

interface JupiterPrice {
  usdPrice: number;
  blockId: number;
  decimals: number;
  priceChange24h?: number;
}

interface JupiterPriceResponse {
  [mint: string]: JupiterPrice;
}

interface EndpointStatus {
  endpoint: string;
  lastSuccess?: number;
  lastFailure?: number;
  consecutiveFailures: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  lastRequestTime?: number;
}

interface JupiterPriceFeedOptions {
  /**
   * Use Pro endpoint (requires API key)
   * Default: false (uses Lite endpoint)
   */
  pro?: boolean;

  /**
   * Disable Jupiter Price Feed entirely
   * Useful if network/firewall blocks access to Jupiter APIs
   * Default: false
   */
  disabled?: boolean;

  /**
   * Connection timeout in milliseconds
   * Default: 5000 (5 seconds)
   */
  timeout?: number;
}

export class JupiterPriceFeed {
  private logger: Logger;
  private priceApiUrl: string;
  private quoteApiUrl = 'https://quote-api.jup.ag/v6';
  private rateLimiter: RateLimiter;
  private endpointStatuses: Map<string, EndpointStatus> = new Map();
  private timeout: number;
  private disabled: boolean;

  constructor(logger: Logger, options?: JupiterPriceFeedOptions) {
    this.logger = logger;
    this.disabled = options?.disabled || false;
    this.timeout = options?.timeout || 5000; // 5 second default

    // Choose endpoint based on pro flag
    this.priceApiUrl = options?.pro
      ? 'https://api.jup.ag/price/v3'
      : 'https://lite-api.jup.ag/price/v3';

    // Jupiter free tier: ~10 requests per second, be conservative
    this.rateLimiter = new RateLimiter({
      maxRequests: 5,
      windowMs: 1000,
      minDelayMs: 200, // Minimum 200ms between requests
    });

    // Initialize endpoint statuses
    this.initializeEndpointStatus('priceApi');
    this.initializeEndpointStatus('quoteApi');

    if (this.disabled) {
      this.logger.info('Jupiter Price Feed is DISABLED', {
        reason: 'Configured as disabled',
      });
    }
  }

  /**
   * Get price from Jupiter for a token pair using enhanced fallback logic
   */
  async getPrice(baseMint: PublicKey, quoteMint: PublicKey): Promise<number | null> {
    if (this.disabled) {
      return null;
    }

    const startTime = Date.now();
    const baseMintStr = baseMint.toString();
    const quoteMintStr = quoteMint.toString();

    try {
      // Try Price API v3 first (faster and more efficient)
      this.logger.debug('Attempting Jupiter price fetch via Price API v3', {
        baseMint: baseMintStr,
        quoteMint: quoteMintStr,
      });

      const priceResult = await this.getPriceFromPriceAPI(baseMint, quoteMint);
      if (priceResult !== null) {
        this.recordSuccess('priceApi', Date.now() - startTime);
        this.logger.info('Successfully fetched Jupiter price via Price API v3', {
          baseMint: baseMintStr,
          quoteMint: quoteMintStr,
          price: priceResult,
          responseTime: Date.now() - startTime,
        });
        return priceResult;
      }

      // Fallback to Quote API if Price API fails
      this.logger.warn('Jupiter Price API v3 failed, falling back to Quote API v6', {
        baseMint: baseMintStr,
        quoteMint: quoteMintStr,
        fallbackReason: 'Primary endpoint unavailable',
      });

      return await this.getPriceFromQuoteAPI(baseMint, quoteMint);

    } catch (error) {
      const responseTime = Date.now() - startTime;

      // Record failure for price API (we tried it first)
      this.recordFailure('priceApi', responseTime);

      this.logger.error('Failed to fetch Jupiter price from both endpoints', {
        baseMint: baseMintStr,
        quoteMint: quoteMintStr,
        error: error instanceof Error ? error.message : 'Unknown error',
        responseTime,
        attemptedEndpoints: ['priceApi', 'quoteApi'],
      });

      return null;
    }
  }

  /**
   * Get endpoint status for monitoring and diagnostics
   */
  getEndpointStatus(endpoint: 'priceApi' | 'quoteApi'): EndpointStatus | null {
    return this.endpointStatuses.get(endpoint) || null;
  }

  /**
   * Get overall Jupiter feed health status
   */
  getOverallStatus(): {
    isHealthy: boolean;
    primaryEndpointHealthy: boolean;
    fallbackEndpointHealthy: boolean;
    totalRequests: number;
    overallSuccessRate: number;
    lastActivity?: number;
    disabled: boolean;
  } {
    const priceApiStatus = this.endpointStatuses.get('priceApi');
    const quoteApiStatus = this.endpointStatuses.get('quoteApi');

    const totalRequests = (priceApiStatus?.totalRequests || 0) + (quoteApiStatus?.totalRequests || 0);
    const totalSuccesses = (priceApiStatus?.successfulRequests || 0) + (quoteApiStatus?.successfulRequests || 0);

    return {
      isHealthy: !this.disabled && totalRequests > 0 && (totalSuccesses / totalRequests) > 0.5,
      primaryEndpointHealthy: !this.disabled && this.isEndpointHealthy('priceApi'),
      fallbackEndpointHealthy: !this.disabled && this.isEndpointHealthy('quoteApi'),
      totalRequests,
      overallSuccessRate: totalRequests > 0 ? totalSuccesses / totalRequests : 0,
      lastActivity: Math.max(
        priceApiStatus?.lastRequestTime || 0,
        quoteApiStatus?.lastRequestTime || 0
      ),
      disabled: this.disabled,
    };
  }

  /**
   * Get prices for multiple tokens (up to 50) using Jupiter Price API v3
   */
  async getPrices(mints: string[]): Promise<JupiterPriceResponse> {
    if (this.disabled) {
      return {};
    }

    if (!mints.length) {
      throw new Error('getPrices() requires at least one mint address.');
    }

    if (mints.length > 50) {
      throw new Error('Jupiter Price API V3 only supports up to 50 mints.');
    }

    const startTime = Date.now();

    try {
      this.recordRequest('priceApi');

      const url = `${this.priceApiUrl}?ids=${mints.join(',')}`;

      // Use AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const response = await this.rateLimiter.execute(async () => {
          return fetch(url, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
            },
            signal: controller.signal,
          });
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const responseTime = Date.now() - startTime;
          this.recordFailure('priceApi', responseTime);
          throw new Error(`Jupiter Price API returned status: ${response.status}`);
        }

        const data = await response.json() as JupiterPriceResponse;
        const responseTime = Date.now() - startTime;

        this.recordSuccess('priceApi', responseTime);

        return this.validateResponse(data, mints);

      } finally {
        clearTimeout(timeoutId);
      }

    } catch (error) {
      const responseTime = Date.now() - startTime;
      this.recordFailure('priceApi', responseTime);

      // Check for connection timeout
      if (error && typeof error === 'object' && 'cause' in error) {
        const cause = (error as any).cause;
        if (cause?.code === 'UND_ERR_CONNECT_TIMEOUT') {
          this.logger.warn('Jupiter Price API connection timeout - network/firewall may be blocking access', {
            endpoint: this.priceApiUrl,
            timeout: this.timeout,
            suggestion: 'Consider setting disabled: true in JupiterPriceFeed options',
          });
        }
      }

      throw error;
    }
  }

  /**
   * Get price using Jupiter Price API v3 (recommended method)
   */
  private async getPriceFromPriceAPI(baseMint: PublicKey, quoteMint: PublicKey): Promise<number | null> {
    const startTime = Date.now();

    try {
      this.recordRequest('priceApi');

      // Jupiter Price API v3 supports multiple IDs comma-separated
      const ids = `${baseMint.toString()},${quoteMint.toString()}`;

      // Use AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const response = await this.rateLimiter.execute(async () => {
          return fetch(
            `${this.priceApiUrl}?ids=${ids}`,
            {
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              signal: controller.signal,
            }
          );
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const responseTime = Date.now() - startTime;

          if (response.status === 429) {
            this.logger.warn('Jupiter Price API rate limit hit, backing off', {
              endpoint: 'priceApi',
              statusCode: response.status,
              responseTime,
            });
            this.recordFailure('priceApi', responseTime);
            throw PriceFeedError.fromHttpResponse('jupiter', response.status, 'Rate limit exceeded', this.priceApiUrl);
          }

          this.recordFailure('priceApi', responseTime);
          throw PriceFeedError.fromHttpResponse('jupiter', response.status, await response.text(), this.priceApiUrl);
        }

        const data = await response.json() as any;
        const responseTime = Date.now() - startTime;

        // Price API v3 response format: { "MintAddress": { "usdPrice": number, "decimals": number, ... } }
        const baseTokenData = data[baseMint.toString()];
        const quoteTokenData = data[quoteMint.toString()];

        if (!baseTokenData) {
          this.recordFailure('priceApi', responseTime);
          this.logger.warn('Token not found in Jupiter Price API - may be untrusted or not traded recently', {
            mint: baseMint.toString(),
            reason: 'Not traded in last 7 days, flagged as suspicious, or insufficient liquidity',
          });
          throw PriceFeedError.fromNoData('jupiter', `${baseMint.toString()}`, 'No price data for base token');
        }

        // v3 uses usdPrice field
        const basePriceUSD = Number(baseTokenData.usdPrice);

        if (!isFinite(basePriceUSD) || basePriceUSD <= 0) {
          this.recordFailure('priceApi', responseTime);
          throw PriceFeedError.fromInvalidResponse('jupiter', `Invalid base price value: ${basePriceUSD}`, baseTokenData);
        }

        // Get quote price
        if (!quoteTokenData) {
          this.recordFailure('priceApi', responseTime);
          throw PriceFeedError.fromNoData('jupiter', `${quoteMint.toString()}`, 'No price data for quote token');
        }

        const quotePriceUSD = Number(quoteTokenData.usdPrice);

        if (!isFinite(quotePriceUSD) || quotePriceUSD <= 0) {
          this.recordFailure('priceApi', responseTime);
          throw PriceFeedError.fromInvalidResponse('jupiter', `Invalid quote price value: ${quotePriceUSD}`, quoteTokenData);
        }

        // Calculate relative price: how much quote token does 1 base token cost
        const relativePrice = basePriceUSD / quotePriceUSD;

        this.logger.debug('Successfully fetched Jupiter price from Price API v3', {
          baseMint: baseMint.toString(),
          quoteMint: quoteMint.toString(),
          basePriceUSD,
          quotePriceUSD,
          relativePrice,
          responseTime,
          endpoint: 'priceApi',
        });

        return relativePrice;

      } finally {
        clearTimeout(timeoutId);
      }

    } catch (error) {
      const responseTime = Date.now() - startTime;

      if (error instanceof PriceFeedError) {
        throw error; // Re-throw our custom errors
      }

      // Handle abort errors (timeout)
      if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') {
        this.recordFailure('priceApi', responseTime);
        this.logger.warn('Jupiter Price API request timed out', {
          endpoint: 'priceApi',
          baseMint: baseMint.toString(),
          quoteMint: quoteMint.toString(),
          timeout: `${this.timeout}ms`,
          responseTime,
        });
        throw PriceFeedError.fromNetworkError('jupiter', `Request timeout after ${this.timeout}ms`, 'Price API v3 request');
      }

      // Check for connection timeout (network/firewall blocking)
      if (error && typeof error === 'object' && 'cause' in error) {
        const cause = (error as any).cause;
        if (cause?.code === 'UND_ERR_CONNECT_TIMEOUT') {
          this.recordFailure('priceApi', responseTime);
          this.logger.error('Jupiter Price API connection blocked - likely network/firewall issue', {
            endpoint: this.priceApiUrl,
            errorCode: cause.code,
            suggestion: 'Check firewall settings or set disabled: true for JupiterPriceFeed',
            baseMint: baseMint.toString(),
            quoteMint: quoteMint.toString(),
          });
          throw PriceFeedError.fromNetworkError('jupiter', 'Connection timeout - network/firewall blocking access', 'Price API v3 request');
        }
      }

      // Log detailed error information for debugging
      const errorDetails: any = {
        baseMint: baseMint.toString(),
        quoteMint: quoteMint.toString(),
        responseTime,
        errorType: error?.constructor?.name || 'Unknown',
      };

      if (error instanceof Error) {
        errorDetails.errorName = error.name;
        errorDetails.errorMessage = error.message;
        errorDetails.errorCause = (error as any).cause;
      }

      this.logger.error('Jupiter Price API fetch failed with detailed error', errorDetails);

      // Convert unknown errors to network errors
      this.recordFailure('priceApi', responseTime);
      throw PriceFeedError.fromNetworkError(
        'jupiter',
        error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown network error',
        'Price API v3 request'
      );
    }
  }

  /**
   * Get price using Jupiter Quote API v6 (fallback method)
   */
  private async getPriceFromQuoteAPI(baseMint: PublicKey, quoteMint: PublicKey): Promise<number | null> {
    const startTime = Date.now();

    try {
      this.recordRequest('quoteApi');

      const response = await this.rateLimiter.execute(async () => {
        return fetch(
          `${this.quoteApiUrl}/quote?inputMint=${baseMint.toString()}&outputMint=${quoteMint.toString()}&amount=1000000&slippageBps=50`,
          {
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );
      });

      if (!response.ok) {
        const responseTime = Date.now() - startTime;

        if (response.status === 429) {
          this.logger.warn('Jupiter Quote API rate limit hit, backing off', {
            endpoint: 'quoteApi',
            statusCode: response.status,
            responseTime,
          });
          this.recordFailure('quoteApi', responseTime);
          throw PriceFeedError.fromHttpResponse('jupiter', response.status, 'Rate limit exceeded', this.quoteApiUrl);
        }

        this.recordFailure('quoteApi', responseTime);
        throw PriceFeedError.fromHttpResponse('jupiter', response.status, await response.text(), this.quoteApiUrl);
      }

      const data = await response.json() as any;
      const responseTime = Date.now() - startTime;

      if (!data.outAmount || !data.inAmount) {
        this.recordFailure('quoteApi', responseTime);
        throw PriceFeedError.fromNoData('jupiter', `${baseMint.toString()}/${quoteMint.toString()}`, 'Missing amount data in response');
      }

      // Calculate price: output tokens / input tokens
      const inAmount = Number(data.inAmount);
      const outAmount = Number(data.outAmount);

      if (inAmount <= 0 || outAmount <= 0) {
        this.recordFailure('quoteApi', responseTime);
        throw PriceFeedError.fromInvalidResponse('jupiter', `Invalid amounts: in=${inAmount}, out=${outAmount}`, data);
      }

      const price = outAmount / inAmount;

      if (!isFinite(price) || price <= 0) {
        this.recordFailure('quoteApi', responseTime);
        throw PriceFeedError.fromInvalidResponse('jupiter', `Invalid calculated price: ${price}`, { inAmount, outAmount, price });
      }

      this.logger.debug('Successfully fetched Jupiter price from Quote API v6 (fallback)', {
        baseMint: baseMint.toString(),
        quoteMint: quoteMint.toString(),
        price,
        responseTime,
        endpoint: 'quoteApi',
        isFallback: true,
      });

      return price;

    } catch (error) {
      const responseTime = Date.now() - startTime;

      if (error instanceof PriceFeedError) {
        throw error; // Re-throw our custom errors
      }

      // Convert unknown errors to network errors
      this.recordFailure('quoteApi', responseTime);
      throw PriceFeedError.fromNetworkError('jupiter', error instanceof Error ? error.message : 'Unknown error', 'Quote API v6 request');
    }
  }

  /**
   * Validates response to ensure all returned prices match expected structure
   */
  private validateResponse(
    data: JupiterPriceResponse,
    mints: string[]
  ): JupiterPriceResponse {
    const result: JupiterPriceResponse = {};

    for (const mint of mints) {
      const p = data[mint];

      if (!p) {
        this.logger.warn('No price found for mint in Jupiter response', { mint });
        continue;
      }

      if (
        typeof p.usdPrice !== 'number' ||
        typeof p.blockId !== 'number' ||
        typeof p.decimals !== 'number'
      ) {
        this.logger.warn('Invalid price schema for mint in Jupiter response', { mint });
        continue;
      }

      result[mint] = p;
    }

    return result;
  }

  /**
   * Initialize endpoint status tracking
   */
  private initializeEndpointStatus(endpoint: string): void {
    this.endpointStatuses.set(endpoint, {
      endpoint,
      consecutiveFailures: 0,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
    });
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

    // Consider healthy if no recent failures or high success rate
    return status.consecutiveFailures < 3 &&
      (status.totalRequests === 0 || status.successfulRequests / status.totalRequests > 0.5);
  }
}
