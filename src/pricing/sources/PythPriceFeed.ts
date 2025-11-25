/**
 * Enhanced Pyth Price Feed with alternative Hermes endpoint support and status tracking
 * Uses @pythnetwork/price-service-client with enhanced monitoring and fallback capabilities
 */

import { PublicKey } from '@solana/web3.js';
import pythPkg from '@pythnetwork/price-service-client';
import { Logger } from '../../utils/Logger.js';
import { PriceFeedError } from '../errors/PriceFeedError.js';

// Handle CommonJS module
const PriceServiceConnection = (pythPkg as any).PriceServiceConnection || pythPkg;

export interface PythPriceData {
  price: number;
  confidence: number;
  expo: number;
  publishTime: number;
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
  isFallback: boolean;
}

export class PythPriceFeed {
  private logger: Logger;
  private primaryConnection: any;
  private fallbackConnection: any;
  private priceCache = new Map<string, PythPriceData>();
  private cacheTTL = 4_000; // 4s cache (Pyth updates ~400-1000ms)
  private primaryEndpointStatuses: EndpointStatus;
  private fallbackEndpointStatuses: EndpointStatus;
  private endpointStatuses: Map<string, EndpointStatus> = new Map();

  // Common Solana mainnet price feed IDs (updated Nov 2025)
  private static readonly FEED_IDS: Record<string, string> = {
    // SOL/USD
    So11111111111111111111111111111111111111112:
      '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    // USDC/USD
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:
      '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
    // USDT/USD
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB:
      '0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
    // JUP/USD
    JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN:
      '0x0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996',
    // BTC/USD (Wrapped)
    '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E':
      '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    // ETH/USD (Wrapped)
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs':
      '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  };

  constructor(logger: Logger, hermesUrl?: string) {
    this.logger = logger;
    
    // Primary endpoint
    const primaryUrl = hermesUrl || process.env.PYTH_HERMES_URL || 'https://hermes.pyth.network';
    // Fallback endpoint  
    const fallbackUrl = process.env.PYTH_HERMES_FALLBACK_URL || 'https://hermes-pyth.network'; // Alternative endpoint
    
    // Initialize connections
    try {
      this.primaryConnection = new PriceServiceConnection(primaryUrl, {
        priceFeedRequestConfig: { binary: true },
      });
      this.fallbackConnection = new PriceServiceConnection(fallbackUrl, {
        priceFeedRequestConfig: { binary: true },
      });
    } catch (error) {
      this.logger.error('Failed to initialize Pyth price service connections', {
        primaryUrl,
        fallbackUrl,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
    
    // Initialize endpoint statuses
    this.primaryEndpointStatuses = this.initializeEndpointStatus('primary', primaryUrl, false);
    this.fallbackEndpointStatuses = this.initializeEndpointStatus('fallback', fallbackUrl, true);
    
    this.endpointStatuses.set('primary', this.primaryEndpointStatuses);
    this.endpointStatuses.set('fallback', this.fallbackEndpointStatuses);
    
    this.logger.info('PythPriceFeed initialized with fallback support', {
      primaryUrl,
      fallbackUrl,
      fallbackEnabled: !!process.env.PYTH_HERMES_FALLBACK_URL,
    });
  }

  /**
   * Get price from Pyth with enhanced fallback logic
   */
  async getPrice(baseMint: PublicKey, quoteMint: PublicKey): Promise<number | null> {
    const startTime = Date.now();
    const baseId = PythPriceFeed.FEED_IDS[baseMint.toBase58()];
    const quoteId = PythPriceFeed.FEED_IDS[quoteMint.toBase58()];
    const baseMintStr = baseMint.toBase58();
    const quoteMintStr = quoteMint.toBase58();

    if (!baseId || !quoteId) {
      this.logger.debug('Pyth feed not available for token pair', {
        base: baseMintStr,
        quote: quoteMintStr,
      });
      return null;
    }

    const cacheKey = `${baseId}_${quoteId}`;
    const cached = this.priceCache.get(cacheKey);
    if (cached && Date.now() - cached.publishTime * 1000 < this.cacheTTL) {
      return cached.price;
    }

    // Try primary endpoint first
    try {
      this.logger.debug('Attempting Pyth price fetch via primary Hermes endpoint', {
        base: baseMintStr,
        quote: quoteMintStr,
        endpoint: 'primary',
      });
      
      const price = await this.fetchFromEndpoint('primary', baseId, quoteId, baseMintStr, quoteMintStr);
      if (price !== null) {
        this.recordSuccess('primary', Date.now() - startTime);
        this.logger.info('Successfully fetched Pyth price via primary endpoint', {
          base: baseMintStr,
          quote: quoteMintStr,
          price,
          responseTime: Date.now() - startTime,
        });
        return price;
      }
    } catch (error) {
      this.recordFailure('primary', Date.now() - startTime);
      this.logger.warn('Primary Hermes endpoint failed', {
        base: baseMintStr,
        quote: quoteMintStr,
        error: error instanceof Error ? error.message : 'Unknown error',
        endpoint: 'primary',
      });
    }

    // Fallback to alternative Hermes endpoint if primary fails
    if (this.fallbackConnection) {
      try {
        this.logger.warn('Falling back to alternative Hermes endpoint', {
          base: baseMintStr,
          quote: quoteMintStr,
          fallbackReason: 'Primary endpoint failed',
          endpoint: 'fallback',
        });
        
        const price = await this.fetchFromEndpoint('fallback', baseId, quoteId, baseMintStr, quoteMintStr);
        if (price !== null) {
          this.recordSuccess('fallback', Date.now() - startTime);
          this.logger.info('Successfully fetched Pyth price via fallback endpoint', {
            base: baseMintStr,
            quote: quoteMintStr,
            price,
            responseTime: Date.now() - startTime,
            isFallback: true,
          });
          return price;
        }
      } catch (error) {
        this.recordFailure('fallback', Date.now() - startTime);
        this.logger.error('Both Hermes endpoints failed', {
          base: baseMintStr,
          quote: quoteMintStr,
          error: error instanceof Error ? error.message : 'Unknown error',
          attemptedEndpoints: ['primary', 'fallback'],
        });
      }
    }

    return null;
  }

  /**
   * Get endpoint status for monitoring and diagnostics
   */
  getEndpointStatus(endpoint: 'primary' | 'fallback'): EndpointStatus | null {
    return this.endpointStatuses.get(endpoint) || null;
  }

  /**
   * Get overall Pyth feed health status
   */
  getOverallStatus(): {
    isHealthy: boolean;
    primaryEndpointHealthy: boolean;
    fallbackEndpointHealthy: boolean;
    fallbackEnabled: boolean;
    totalRequests: number;
    overallSuccessRate: number;
    lastActivity?: number;
  } {
    const totalRequests = this.primaryEndpointStatuses.totalRequests + this.fallbackEndpointStatuses.totalRequests;
    const totalSuccesses = this.primaryEndpointStatuses.successfulRequests + this.fallbackEndpointStatuses.successfulRequests;
    
    return {
      isHealthy: totalRequests > 0 && (totalSuccesses / totalRequests) > 0.5,
      primaryEndpointHealthy: this.isEndpointHealthy('primary'),
      fallbackEndpointHealthy: this.isEndpointHealthy('fallback'),
      fallbackEnabled: !!this.fallbackConnection,
      totalRequests,
      overallSuccessRate: totalRequests > 0 ? totalSuccesses / totalRequests : 0,
      lastActivity: Math.max(
        this.primaryEndpointStatuses.lastRequestTime || 0,
        this.fallbackEndpointStatuses.lastRequestTime || 0
      ),
    };
  }

  /**
   * Fetch price from specific endpoint
   */
  private async fetchFromEndpoint(
    endpoint: 'primary' | 'fallback',
    baseId: string,
    quoteId: string,
    baseMintStr: string,
    quoteMintStr: string
  ): Promise<number | null> {
    // const startTime = Date.now(); // Unused - response time tracked in retry manager
    const connection = endpoint === 'primary' ? this.primaryConnection : this.fallbackConnection;
    
    try {
      this.recordRequest(endpoint);
      
      const priceFeeds = await connection.getLatestPriceFeeds([
        baseId,
        quoteId,
      ]);

      if (!priceFeeds || priceFeeds.length < 2) {
        throw PriceFeedError.fromNoData('pyth', `${baseMintStr}/${quoteMintStr}`, 'Insufficient price feeds returned');
      }

      const baseFeed = priceFeeds.find((p: any) => p.id === baseId);
      const quoteFeed = priceFeeds.find((p: any) => p.id === quoteId);

      if (!baseFeed || !quoteFeed) {
        throw PriceFeedError.fromNoData('pyth', `${baseMintStr}/${quoteMintStr}`, 'Required price feeds not found');
      }

      const basePrice = baseFeed.getPriceUnchecked();
      const quotePrice = quoteFeed.getPriceUnchecked();

      if (!basePrice?.price || !quotePrice?.price) {
        throw PriceFeedError.fromNoData('pyth', `${baseMintStr}/${quoteMintStr}`, 'Price data unavailable');
      }

      // Convert from Pyth format (price * 10^expo)
      const baseValue = Number(basePrice.price) * Math.pow(10, basePrice.expo);
      const quoteValue = Number(quotePrice.price) * Math.pow(10, quotePrice.expo);

      if (baseValue <= 0 || quoteValue <= 0) {
        throw PriceFeedError.fromInvalidResponse('pyth', `Invalid price values: base=${baseValue}, quote=${quoteValue}`, {
          basePrice,
          quotePrice,
        });
      }

      const price = baseValue / quoteValue;

      if (!Number.isFinite(price) || price <= 0) {
        throw PriceFeedError.fromInvalidResponse('pyth', `Invalid calculated price: ${price}`, { baseValue, quoteValue });
      }

      // Check confidence (± conf interval)
      const basePriceNum = Math.abs(Number(basePrice.price));
      const quotePriceNum = Math.abs(Number(quotePrice.price));
      const baseConfPct = basePriceNum > 0 ? Number(basePrice.conf) / basePriceNum : 1;
      const quoteConfPct = quotePriceNum > 0 ? Number(quotePrice.conf) / quotePriceNum : 1;

      if (baseConfPct > 0.05 || quoteConfPct > 0.05) {
        // >5% deviation
        this.logger.warn('Pyth price confidence too low', {
          endpoint,
          baseConfPct: (baseConfPct * 100).toFixed(2) + '%',
          quoteConfPct: (quoteConfPct * 100).toFixed(2) + '%',
        });
      }

      // Check age (Pyth should update every ~400ms–1s)
      const nowSec = Date.now() / 1000;
      const ageSec = nowSec - basePrice.publishTime;

      if (ageSec > 90) {
        throw PriceFeedError.fromNoData('pyth', `${baseMintStr}/${quoteMintStr}`, `Price data too old: ${ageSec.toFixed(1)}s`);
      }

      // Cache result
      const cacheKey = `${baseId}_${quoteId}`;
      this.priceCache.set(cacheKey, {
        price,
        confidence: 1 - Math.max(baseConfPct, quoteConfPct),
        expo: 0,
        publishTime: basePrice.publishTime,
      });

      this.logger.debug('Successfully fetched Pyth price', {
        base: baseMintStr,
        quote: quoteMintStr,
        price,
        ageSec: ageSec.toFixed(2),
        endpoint,
        isFallback: endpoint === 'fallback',
      });

      return price;

    } catch (error) {
      // const responseTime = Date.now() - startTime; // Unused - response time tracked in retry manager
      
      if (error instanceof PriceFeedError) {
        throw error; // Re-throw our custom errors
      }
      
      // Convert unknown errors to network errors
      throw PriceFeedError.fromNetworkError('pyth', error instanceof Error ? error : 'Unknown error', `${endpoint} endpoint request`);
    }
  }

  /**
   * Initialize endpoint status tracking
   */
  private initializeEndpointStatus(endpoint: string, url: string, isFallback: boolean): EndpointStatus {
    return {
      endpoint,
      url,
      consecutiveFailures: 0,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
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
    
    // Consider healthy if no recent failures or high success rate
    return status.consecutiveFailures < 3 && 
           (status.totalRequests === 0 || status.successfulRequests / status.totalRequests > 0.5);
  }

  /**
   * Clear price cache
   */
  clearCache(): void {
    this.priceCache.clear();
  }

  /**
   * Optional: real-time subscription (enhanced with status tracking)
   */
  subscribe(
    baseMint: PublicKey,
    quoteMint: PublicKey,
    callback: (price: number) => void
  ): () => void {
    const baseId = PythPriceFeed.FEED_IDS[baseMint.toBase58()];
    const quoteId = PythPriceFeed.FEED_IDS[quoteMint.toBase58()];

    if (!baseId || !quoteId) throw new Error('No Pyth feed for tokens');

    let latestBase: any = null;
    let latestQuote: any = null;

    const updatePrice = () => {
      if (latestBase && latestQuote) {
        const baseVal = Number(latestBase.price) * Math.pow(10, latestBase.expo);
        const quoteVal = Number(latestQuote.price) * Math.pow(10, latestQuote.expo);
        if (baseVal > 0 && quoteVal > 0) {
          callback(baseVal / quoteVal);
        }
      }
    };

    this.primaryConnection.subscribePriceFeedUpdates([baseId], (pf: any) => {
      const p = pf.getPriceUnchecked();
      if (p) latestBase = p;
      updatePrice();
    });

    this.primaryConnection.subscribePriceFeedUpdates([quoteId], (pf: any) => {
      const p = pf.getPriceUnchecked();
      if (p) latestQuote = p;
      updatePrice();
    });

    return () => {
      this.primaryConnection.unsubscribePriceFeedUpdates([baseId, quoteId]);
    };
  }
}
