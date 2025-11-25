/**
 * Enhanced Dexscreener Price Feed with error recovery and status tracking
 * Uses official Dexscreener API endpoints with enhanced monitoring and retry capabilities
 */

import { PublicKey } from '@solana/web3.js';
import { Logger } from '../../utils/Logger.js';
import { PriceFeedError } from '../errors/PriceFeedError.js';

interface DexPair {
  pairAddress: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  priceNative?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  fdv?: number;
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
  liquidityThreshold: number;
  volumeThreshold: number;
}

export class DexscreenerFeed {
  private logger: Logger;
  private baseUrl = 'https://api.dexscreener.com';
  private endpointStatuses: Map<string, EndpointStatus> = new Map();

  // Cache: mint → { priceInQuote, timestamp }
  private cache = new Map<string, { price: number; ts: number }>();
  private cacheTTL = 5_000; // 5 seconds

  // Retry configuration
  private readonly maxRetries = 3;
  private readonly baseRetryDelay = 100; // ms
  private readonly maxRetryDelay = 1000; // ms

  constructor(logger: Logger) {
    this.logger = logger;
    
    // Initialize endpoint status tracking
    const primaryEndpoint = this.initializeEndpointStatus('primary', `${this.baseUrl}/token-pairs/v1/solana`, 10000, 5000);
    this.endpointStatuses.set('primary', primaryEndpoint);
    
    this.logger.info('DexscreenerFeed initialized with enhanced error recovery', {
      baseUrl: this.baseUrl,
      liquidityThreshold: primaryEndpoint.liquidityThreshold,
      volumeThreshold: primaryEndpoint.volumeThreshold,
    });
  }

  /**
   * Get price from Dexscreener with enhanced error recovery
   */
  async getPrice(baseMint: PublicKey, quoteMint: PublicKey): Promise<number | null> {
    const startTime = Date.now();
    const baseStr = baseMint.toBase58();
    const quoteStr = quoteMint.toBase58();
    const cacheKey = this.getCacheKey(baseStr, quoteStr);

    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTTL) {
      this.logger.debug('Dexscreener price from cache', {
        base: baseStr.slice(0, 6),
        quote: quoteStr.slice(0, 6),
        price: cached.price,
        cacheAge: Date.now() - cached.ts,
      });
      return cached.price;
    }

    // Try with retry logic
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        this.logger.debug(`Dexscreener price fetch attempt ${attempt}/${this.maxRetries}`, {
          base: baseStr.slice(0, 6),
          quote: quoteStr.slice(0, 6),
          attempt,
        });
        
        const price = await this.fetchPriceWithRetry(baseStr, quoteStr, attempt);
        if (price !== null) {
          this.recordSuccess('primary', Date.now() - startTime);
          
          // Cache successful result
          this.cache.set(cacheKey, { price, ts: Date.now() });
          
          this.logger.info('Successfully fetched Dexscreener price', {
            base: baseStr.slice(0, 6),
            quote: quoteStr.slice(0, 6),
            price,
            responseTime: Date.now() - startTime,
            attempts: attempt,
          });
          
          return price;
        }
        
        // If price is null but no error, break out (likely no valid pairs)
        break;
        
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        this.logger.warn(`Dexscreener price fetch attempt ${attempt} failed`, {
          base: baseStr.slice(0, 6),
          quote: quoteStr.slice(0, 6),
          attempt,
          error: lastError.message,
          retryable: this.isRetryableError(lastError),
        });
        
        // Don't retry on non-retryable errors
        if (!this.isRetryableError(lastError)) {
          break;
        }
        
        // Wait before retry (exponential backoff)
        if (attempt < this.maxRetries) {
          const delay = Math.min(
            this.baseRetryDelay * Math.pow(2, attempt - 1),
            this.maxRetryDelay
          );
          
          this.logger.debug(`Retrying Dexscreener price fetch in ${delay}ms`, {
            base: baseStr.slice(0, 6),
            quote: quoteStr.slice(0, 6),
            attempt,
            delay,
          });
          
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    // All attempts failed
    const responseTime = Date.now() - startTime;
    this.recordFailure('primary', responseTime);
    
    this.logger.error('Dexscreener price fetch failed after all retries', {
      base: baseStr.slice(0, 6),
      quote: quoteStr.slice(0, 6),
      error: lastError?.message || 'Unknown error',
      attempts: this.maxRetries,
      responseTime,
    });
    
    return null;
  }

  /**
   * Get endpoint status for monitoring and diagnostics
   */
  getEndpointStatus(): EndpointStatus | null {
    return this.endpointStatuses.get('primary') || null;
  }

  /**
   * Get overall Dexscreener feed health status
   */
  getOverallStatus(): {
    isHealthy: boolean;
    endpointHealthy: boolean;
    totalRequests: number;
    overallSuccessRate: number;
    lastActivity?: number;
    consecutiveFailures: number;
  } {
    const status = this.endpointStatuses.get('primary');
    const totalRequests = status?.totalRequests || 0;
    const totalSuccesses = status?.successfulRequests || 0;
    
    return {
      isHealthy: totalRequests > 0 && (totalSuccesses / totalRequests) > 0.4, // More lenient for DEX data
      endpointHealthy: this.isEndpointHealthy('primary'),
      totalRequests,
      overallSuccessRate: totalRequests > 0 ? totalSuccesses / totalRequests : 0,
      lastActivity: status?.lastRequestTime,
      consecutiveFailures: status?.consecutiveFailures || 0,
    };
  }

  /**
   * Fetch price with retry logic
   */
  private async fetchPriceWithRetry(baseStr: string, quoteStr: string, attempt: number): Promise<number | null> {
    this.recordRequest('primary');
    
    // Use timeout based on attempt (longer timeout for retries)
    const timeout = Math.min(8000 * attempt, 15000); // Max 15s
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      
      const url = `${this.baseUrl}/token-pairs/v1/solana/${baseStr}`;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 404) {
          // Token not found - this is not retryable
          throw PriceFeedError.fromNoData('dexscreener', `${baseStr}/${quoteStr}`, 'Token not found in DEX pairs');
        }
        
        if (response.status === 429) {
          // Rate limit - retryable
          throw PriceFeedError.fromHttpResponse('dexscreener', response.status, 'Rate limit exceeded', url);
        }
        
        if (response.status >= 500) {
          // Server error - retryable
          throw PriceFeedError.fromHttpResponse('dexscreener', response.status, 'Server error', url);
        }
        
        // Client error - not retryable
        const responseText = await response.text();
        throw PriceFeedError.fromHttpResponse('dexscreener', response.status, responseText, url);
      }

      const data = await response.json();
      return await this.processDexPairs(data, baseStr, quoteStr);

    } catch (error) {
      if (error instanceof PriceFeedError) {
        throw error; // Re-throw our custom errors
      }
      
      if ((error as any).name === 'AbortError') {
        // Timeout error - retryable
        throw PriceFeedError.fromNetworkError('dexscreener', 'Request timeout', `fetchPrice attempt ${attempt}`);
      }
      
      // Network or other errors - retryable
      throw PriceFeedError.fromNetworkError('dexscreener', error instanceof Error ? error : new Error(String(error)), `fetchPrice attempt ${attempt}`);
    }
  }

  /**
   * Process DEX pairs and extract price
   */
  private async processDexPairs(data: any, baseStr: string, quoteStr: string): Promise<number | null> {
    const pairs: DexPair[] = Array.isArray(data) ? data : data.pairs || [];

    if (pairs.length === 0) {
      throw PriceFeedError.fromNoData('dexscreener', `${baseStr}/${quoteStr}`, 'No DEX pairs found');
    }

    // Get thresholds from endpoint status
    const status = this.endpointStatuses.get('primary');
    const liquidityThreshold = status?.liquidityThreshold || 10000;
    const volumeThreshold = status?.volumeThreshold || 5000;

    // Filter and sort by liquidity + volume
    const validPairs = pairs
      .filter((p): p is DexPair => {
        const liq = p.liquidity?.usd ?? 0;
        const vol = p.volume?.h24 ?? 0;
        return (
          p.baseToken.address.toLowerCase() === baseStr.toLowerCase() &&
          liq >= liquidityThreshold &&
          vol >= volumeThreshold
        );
      })
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)); // highest liquidity first

    if (validPairs.length === 0) {
      this.logger.debug('Dexscreener: no valid pools (low liquidity/volume)', { 
        base: baseStr,
        liquidityThreshold,
        volumeThreshold,
        totalPairs: pairs.length,
      });
      throw PriceFeedError.fromNoData('dexscreener', `${baseStr}/${quoteStr}`, 'No pools with sufficient liquidity/volume');
    }

    let selectedPair = validPairs[0];

    // Try exact quote match first
    const exactMatch = validPairs.find(
      (p) => p.quoteToken.address.toLowerCase() === quoteStr.toLowerCase()
    );
    if (exactMatch) selectedPair = exactMatch;

    const priceUsd = parseFloat(selectedPair.priceUsd || '0');
    const priceNative = parseFloat(selectedPair.priceNative || '0');

    let rawPrice: number;

    // Determine price based on quote token
    if (
      quoteStr === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' || // USDC
      quoteStr === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'   // USDT
    ) {
      rawPrice = priceUsd || priceNative; // priceNative is usually in USDC
    } else if (quoteStr === 'So11111111111111111111111111111111111111112') {
      // SOL
      rawPrice = priceNative; // priceNative = price in SOL
    } else {
      // Arbitrary quote → convert via USD
      if (!priceUsd || priceUsd <= 0) {
        throw PriceFeedError.fromNoData('dexscreener', `${baseStr}/${quoteStr}`, 'No USD price available for conversion');
      }
      
      const quotePriceUsd = await this.getUsdPrice(quoteStr);
      if (!quotePriceUsd) {
        throw PriceFeedError.fromNoData('dexscreener', quoteStr, 'No USD price available for quote token');
      }
      rawPrice = priceUsd / quotePriceUsd;
    }

    if (!rawPrice || !isFinite(rawPrice) || rawPrice <= 0) {
      throw PriceFeedError.fromInvalidResponse('dexscreener', `Invalid calculated price: ${rawPrice}`, {
        priceUsd,
        priceNative,
        selectedPair: selectedPair.pairAddress,
      });
    }

    this.logger.debug('Successfully processed Dexscreener pairs', {
      base: baseStr.slice(0, 6),
      quote: quoteStr.slice(0, 6),
      price: rawPrice,
      pair: selectedPair.pairAddress,
      liquidityUsd: selectedPair.liquidity?.usd?.toFixed(0),
      volume24h: selectedPair.volume?.h24?.toFixed(0),
      validPairsCount: validPairs.length,
    });

    return rawPrice;
  }

  /**
   * Get USD price for any token (with cache)
   */
  private async getUsdPrice(mint: string): Promise<number | null> {
    if (mint === 'So11111111111111111111111111111111111111112') {
      // SOL USD price via Dexscreener (fast)
      const res = await fetch(`${this.baseUrl}/token-pairs/v1/solana/${mint}`);
      if (!res.ok) return null;
      const pairs: DexPair[] = ((await res.json()) as DexPair[]) || [];
      const best = pairs.find((p) => (p.liquidity?.usd || 0) > 100_000);
      return best ? parseFloat(best.priceUsd || '0') || null : null;
    }

    const url = `${this.baseUrl}/token-pairs/v1/solana/${mint}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const pairs: DexPair[] = ((await res.json()) as DexPair[]) || [];
    const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return best ? parseFloat(best.priceUsd || '0') || null : null;
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    
    // Network errors and timeouts are retryable
    if (message.includes('network') || 
        message.includes('timeout') ||
        message.includes('econnreset') ||
        message.includes('econnrefused') ||
        message.includes('enotfound') ||
        message.includes('econnaborted')) {
      return true;
    }
    
    // Server errors (5xx) are retryable
    if (message.includes('http 5') || 
        message.includes('server error') ||
        message.includes('rate limit') ||
        message.includes('429')) {
      return true;
    }
    
    // Client errors (4xx) are generally not retryable
    if (message.includes('http 4') && !message.includes('429')) {
      return false;
    }
    
    // Default to retryable for unknown errors
    return true;
  }

  private getCacheKey(base: string, quote: string): string {
    return `${base}_${quote}`;
  }

  /**
   * Initialize endpoint status tracking
   */
  private initializeEndpointStatus(endpoint: string, url: string, liquidityThreshold: number, volumeThreshold: number): EndpointStatus {
    return {
      endpoint,
      url,
      consecutiveFailures: 0,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
      liquidityThreshold,
      volumeThreshold,
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
    
    // Consider healthy if no recent failures or reasonable success rate
    return status.consecutiveFailures < 3 && 
           (status.totalRequests === 0 || status.successfulRequests / status.totalRequests > 0.4);
  }

  /**
   * Clear price cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}
