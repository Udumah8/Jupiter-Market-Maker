/**
 * Enhanced Price Aggregator with comprehensive fallback hierarchy and monitoring
 * Integrates HealthMonitor, ReliabilityTracker, and RetryManager for robust price aggregation
 */

import { PublicKey } from '@solana/web3.js';
import { Logger } from '../utils/Logger.js';
import { JupiterPriceFeed } from './sources/JupiterPriceFeed.js';
import { PythPriceFeed } from './sources/PythPriceFeed.js';
import { BirdeyePriceFeed } from './sources/BirdeyePriceFeed.js';
import { DexscreenerFeed } from './sources/DexscreenerFeed.js';
import { HealthMonitor } from './monitoring/HealthMonitor.js';
import { ReliabilityTracker } from './monitoring/ReliabilityTracker.js';
import { RetryManager } from './monitoring/RetryManager.js';
import { PriceFeedError } from './errors/PriceFeedError.js';

export interface EnhancedPriceData {
  price: number;
  source: string;
  confidence: number;
  timestamp: number;
  responseTime: number;
  errorType?: string;
  isFromCache: boolean;
}

export interface AggregatedPriceResult {
  midPrice: number;
  bestBid: number;
  bestAsk: number;
  sources: EnhancedPriceData[];
  confidence: number;
  timestamp: number;
  fallbackTier: number;
  tierDescription: string;
  cacheHit: boolean;
  totalResponseTime: number;
  sourcesAttempted: string[];
  sourcesSucceeded: string[];
  sourcesFailed: string[];
  priceDeviationPercent?: number;
  filteredOutliers: EnhancedPriceData[];
}

export interface CacheEntry {
  price: AggregatedPriceResult;
  timestamp: number;
  expiresAt: number;
}

export interface EnhancedPriceAggregatorConfig {
  // Basic configuration (inherits from PriceAggregatorConfig)
  cacheDurationMs: number;
  minSources: number;
  maxPriceDeviationPercent: number;
  spreadPercent: number;
  enableCircuitBreaker: boolean;
  circuitBreakerThresholdPercent: number;

  // Enhanced features
  recentCacheDurationMs: number;
  staleCacheDurationMs: number;
  enableRetryLogic: boolean;
  enableHealthMonitoring: boolean;
  enableReliabilityTracking: boolean;
  enablePriceValidation: boolean;

  // Fallback tiers
  tier1MinSources: number;
  tier1Confidence: number;
  tier2Confidence: number;
  tier3Confidence: number;
  tier4Confidence: number;

  // Validation thresholds
  priceDeviationThresholdPercent: number;
  outlierThresholdPercent: number;

  // Monitoring
  enableDetailedLogging: boolean;
  enableMetricsCollection: boolean;
}

export class EnhancedPriceAggregator {
  private jupiterFeed: JupiterPriceFeed;
  private pythFeed: PythPriceFeed;
  private birdeyeFeed: BirdeyePriceFeed;
  private dexscreenerFeed: DexscreenerFeed;
  private logger: Logger;
  private config: EnhancedPriceAggregatorConfig;

  // Monitoring components (optional, initialized conditionally)
  private healthMonitor?: HealthMonitor;
  private reliabilityTracker?: ReliabilityTracker;
  private retryManager?: RetryManager;

  // Caching
  private recentCache: Map<string, CacheEntry> = new Map();
  private staleCache: Map<string, CacheEntry> = new Map();

  // Metrics
  private requestCount = 0;
  private cacheHitCount = 0;
  private tierUsageCount = new Map<number, number>();
  private averageResponseTime = 0;
  // private lastPrice: number | null = null; // Unused - price state maintained in cache

  constructor(config: EnhancedPriceAggregatorConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    // Initialize monitoring components if enabled
    if (this.config.enableHealthMonitoring) {
      this.healthMonitor = new HealthMonitor(logger);
    }

    if (this.config.enableReliabilityTracking) {
      this.reliabilityTracker = new ReliabilityTracker(logger);
    }

    if (this.config.enableRetryLogic) {
      this.retryManager = new RetryManager(logger);
    }

    // Initialize price feeds
    this.jupiterFeed = new JupiterPriceFeed(logger, {
      disabled: process.env.JUPITER_DISABLED === 'true'
    });
    this.pythFeed = new PythPriceFeed(logger, process.env.PYTH_HERMES_URL);
    this.birdeyeFeed = new BirdeyePriceFeed(logger, process.env.BIRDEYE_API_KEY);
    this.dexscreenerFeed = new DexscreenerFeed(logger);

    this.logger.info('EnhancedPriceAggregator initialized', {
      enableRetryLogic: this.config.enableRetryLogic,
      enableHealthMonitoring: this.config.enableHealthMonitoring,
      enableReliabilityTracking: this.config.enableReliabilityTracking,
      enablePriceValidation: this.config.enablePriceValidation,
      recentCacheDuration: this.config.recentCacheDurationMs,
      staleCacheDuration: this.config.staleCacheDurationMs,
    });
  }

  /**
   * Get aggregated price using 5-tier fallback hierarchy
   */
  async getPrice(
    baseMint: PublicKey,
    quoteMint: PublicKey,
    forceRefresh: boolean = false
  ): Promise<AggregatedPriceResult> {
    const startTime = Date.now();
    const cacheKey = `${baseMint.toString()}_${quoteMint.toString()}`;
    this.requestCount++;

    this.logger.debug(`Starting price fetch for ${cacheKey}`, {
      forceRefresh,
      requestId: this.requestCount,
    });

    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        this.cacheHitCount++;
        this.logger.debug('Cache hit for price request', {
          cacheKey,
          tier: cached.fallbackTier,
          cacheType: this.isRecentCache(cacheKey) ? 'recent' : 'stale',
        });
        return this.addTimingToResult(cached, Date.now() - startTime);
      }
    }

    // Try tier-by-tier fallback
    let result: AggregatedPriceResult;

    // Tier 1: Fetch from 2+ sources, calculate median
    result = await this.tryTier1(baseMint, quoteMint);
    if (result.sources.length >= this.config.tier1MinSources) {
      return this.finalizeResult(result, startTime, cacheKey);
    }

    // Tier 2: Use single source if only 1 available
    if (result.sources.length >= 1) {
      result.fallbackTier = 2;
      result.tierDescription = 'Single source fallback';
      result.confidence = this.config.tier2Confidence;
      return this.finalizeResult(result, startTime, cacheKey);
    }

    // Tier 3: Use recent cache if <30s old
    const recentCached = this.recentCache.get(cacheKey);
    if (recentCached) {
      result = { ...recentCached.price };
      result.fallbackTier = 3;
      result.tierDescription = 'Recent cache fallback';
      result.confidence = this.config.tier3Confidence;
      result.cacheHit = true;
      return this.finalizeResult(result, startTime, cacheKey);
    }

    // Tier 4: Use stale cache if <5min old
    const staleCached = this.staleCache.get(cacheKey);
    if (staleCached) {
      result = { ...staleCached.price };
      result.fallbackTier = 4;
      result.tierDescription = 'Stale cache fallback';
      result.confidence = this.config.tier4Confidence;
      result.cacheHit = true;
      return this.finalizeResult(result, startTime, cacheKey);
    }

    // Tier 5: Error if no fallback available
    const error = PriceFeedError.fromNetworkError(
      'EnhancedPriceAggregator',
      'No price sources available and no cached data',
      'getPrice'
    );

    this.logger.error('All price fetch tiers failed', {
      baseMint: baseMint.toString(),
      quoteMint: quoteMint.toString(),
      error: error.message,
    });

    throw error;
  }

  /**
   * Tier 1: Fetch from 2+ sources with weighted median
   */
  private async tryTier1(
    baseMint: PublicKey,
    quoteMint: PublicKey
  ): Promise<AggregatedPriceResult> {
    const sources = ['jupiter', 'pyth', 'birdeye', 'dexscreener'];
    const sourcePromises: Promise<EnhancedPriceData | null>[] = [];

    // Prepare fetch operations with retry logic
    for (const source of sources) {
      sourcePromises.push(this.fetchFromSourceWithRetry(source, baseMint, quoteMint));
    }

    // Execute all fetches in parallel
    const results = await Promise.allSettled(sourcePromises);
    const validPrices: EnhancedPriceData[] = [];

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        validPrices.push(result.value);
      }
    }

    // Filter prices if validation is enabled
    let filteredPrices = validPrices;
    if (this.config.enablePriceValidation && validPrices.length > 1) {
      filteredPrices = this.filterPriceOutliers(validPrices);
    }

    // Calculate weighted median
    const finalPrices = filteredPrices.length > 0 ? filteredPrices : validPrices;
    const midPrice = finalPrices.length > 0 ? this.calculateWeightedMedian(finalPrices) : 0;

    return {
      midPrice,
      bestBid: midPrice * (1 - this.config.spreadPercent / 200),
      bestAsk: midPrice * (1 + this.config.spreadPercent / 200),
      sources: finalPrices,
      confidence: this.config.tier1Confidence,
      timestamp: Date.now(),
      fallbackTier: 1,
      tierDescription: 'Multi-source with weighted median',
      cacheHit: false,
      totalResponseTime: 0,
      sourcesAttempted: sources,
      sourcesSucceeded: finalPrices.map(p => p.source),
      sourcesFailed: sources.filter(s => !finalPrices.find(p => p.source === s)),
      filteredOutliers: validPrices.filter(p => !finalPrices.includes(p)),
    };
  }

  /**
   * Fetch price from a single source with monitoring
   */
  private async fetchFromSourceWithRetry(
    source: string,
    baseMint: PublicKey,
    quoteMint: PublicKey
  ): Promise<EnhancedPriceData | null> {
    const startTime = Date.now();

    try {
      // Check if source is healthy
      if (this.config.enableHealthMonitoring &&
        this.healthMonitor &&
        !this.healthMonitor.isSourceHealthy(source)) {
        this.logger.debug(`Skipping unhealthy source: ${source}`);
        return null;
      }

      // Execute fetch with retry logic
      let priceData: number | null;

      if (this.config.enableRetryLogic && this.retryManager) {
        const retryResult = await this.retryManager.executeWithRetry(
          source,
          () => this.fetchRawPrice(source, baseMint, quoteMint),
          `fetchPrice:${source}`
        );

        if (!retryResult.success) {
          // Record failure in monitoring systems
          if (this.config.enableHealthMonitoring && this.healthMonitor) {
            this.healthMonitor.recordFailure(source);
          }
          return null;
        }

        priceData = retryResult.data || null;
      } else {
        priceData = await this.fetchRawPrice(source, baseMint, quoteMint);
      }

      if (!priceData || !isFinite(priceData) || priceData <= 0) {
        throw PriceFeedError.fromNoData(source, `${baseMint.toString()}/${quoteMint.toString()}`, 'Invalid price data');
      }

      const responseTime = Date.now() - startTime;

      // Record success in monitoring systems
      if (this.config.enableHealthMonitoring && this.healthMonitor) {
        this.healthMonitor.recordSuccess(source);
      }

      if (this.config.enableReliabilityTracking && this.reliabilityTracker) {
        this.reliabilityTracker.recordRequest(source, true, responseTime, priceData);
      }

      this.logger.debug(`Successfully fetched price from ${source}`, {
        source,
        price: priceData,
        responseTime,
      });

      return {
        price: priceData,
        source,
        confidence: this.getSourceConfidence(source),
        timestamp: Date.now(),
        responseTime,
        isFromCache: false,
      };

    } catch (error) {
      const responseTime = Date.now() - startTime;

      // Record failure in monitoring systems
      if (this.config.enableHealthMonitoring && this.healthMonitor) {
        this.healthMonitor.recordFailure(source);
      }

      if (this.config.enableReliabilityTracking && this.reliabilityTracker) {
        this.reliabilityTracker.recordRequest(source, false, responseTime);
      }

      this.logger.debug(`Failed to fetch price from ${source}`, {
        source,
        error: error instanceof Error ? error.message : 'Unknown error',
        responseTime,
      });

      return null;
    }
  }

  /**
   * Fetch raw price from a specific source
   */
  private async fetchRawPrice(
    source: string,
    baseMint: PublicKey,
    quoteMint: PublicKey
  ): Promise<number | null> {
    let feed: any;

    switch (source) {
      case 'jupiter':
        feed = this.jupiterFeed;
        break;
      case 'pyth':
        feed = this.pythFeed;
        break;
      case 'birdeye':
        feed = this.birdeyeFeed;
        break;
      case 'dexscreener':
        feed = this.dexscreenerFeed;
        break;
      default:
        throw PriceFeedError.fromInvalidResponse(source, `Unknown source: ${source}`);
    }

    return await feed.getPrice(baseMint, quoteMint);
  }

  /**
   * Calculate weighted median using confidence scores
   */
  private calculateWeightedMedian(prices: EnhancedPriceData[]): number {
    if (prices.length === 0) return 0;
    if (prices.length === 1) return prices[0].price;

    // Sort prices
    const sortedPrices = [...prices].sort((a, b) => a.price - b.price);

    // Create weighted list
    const weightedPrices: number[] = [];
    for (const priceData of sortedPrices) {
      // Add price multiple times based on confidence (confidence * 100 weight)
      const weight = Math.max(1, Math.round(priceData.confidence * 100));
      for (let i = 0; i < weight; i++) {
        weightedPrices.push(priceData.price);
      }
    }

    // Find median of weighted list
    const mid = Math.floor(weightedPrices.length / 2);
    if (weightedPrices.length % 2 === 0) {
      return (weightedPrices[mid - 1] + weightedPrices[mid]) / 2;
    } else {
      return weightedPrices[mid];
    }
  }

  /**
   * Filter price outliers based on deviation from median
   */
  private filterPriceOutliers(prices: EnhancedPriceData[]): EnhancedPriceData[] {
    if (prices.length < 2) return prices;

    const median = this.calculateWeightedMedian(prices);
    const threshold = this.config.outlierThresholdPercent / 100;

    return prices.filter(priceData => {
      const deviation = Math.abs((priceData.price - median) / median);
      const isOutlier = deviation > threshold;

      if (isOutlier && this.config.enableDetailedLogging) {
        this.logger.debug('Filtering out price outlier', {
          source: priceData.source,
          price: priceData.price,
          median,
          deviation: (deviation * 100).toFixed(2) + '%',
          threshold: (threshold * 100).toFixed(2) + '%',
        });
      }

      return !isOutlier;
    });
  }

  /**
   * Get confidence score for a source
   */
  private getSourceConfidence(source: string): number {
    const baseConfidence: Record<string, number> = {
      'jupiter': 0.9,
      'pyth': 0.95,
      'birdeye': 0.85,
      'dexscreener': 0.8,
    };

    let confidence = baseConfidence[source] || 0.7;

    // Adjust confidence based on reliability if tracking is enabled
    if (this.config.enableReliabilityTracking && this.reliabilityTracker) {
      const reliabilityScore = this.reliabilityTracker.getReliabilityScore(source);
      confidence *= reliabilityScore;
    }

    return Math.max(0.1, Math.min(1.0, confidence));
  }

  /**
   * Get cached price if available and not expired
   */
  private getFromCache(cacheKey: string): AggregatedPriceResult | null {
    const recent = this.recentCache.get(cacheKey);
    if (recent && Date.now() < recent.expiresAt) {
      return recent.price;
    }

    const stale = this.staleCache.get(cacheKey);
    if (stale && Date.now() < stale.expiresAt) {
      return stale.price;
    }

    return null;
  }

  /**
   * Check if key is in recent cache
   */
  private isRecentCache(cacheKey: string): boolean {
    return this.recentCache.has(cacheKey) &&
      Date.now() < (this.recentCache.get(cacheKey)?.expiresAt || 0);
  }

  /**
   * Add timing information to result and update metrics
   */
  private finalizeResult(result: AggregatedPriceResult, startTime: number, cacheKey: string): AggregatedPriceResult {
    const totalTime = Date.now() - startTime;
    result.totalResponseTime = totalTime;

    // Update cache
    this.updateCache(cacheKey, result);

    // Update metrics
    this.updateMetrics(result);

    // Log result if detailed logging is enabled
    if (this.config.enableDetailedLogging) {
      this.logger.info('Price aggregation completed', {
        tier: result.fallbackTier,
        tierDescription: result.tierDescription,
        sourcesCount: result.sources.length,
        confidence: result.confidence,
        price: result.midPrice,
        totalTime,
        cacheHit: result.cacheHit,
      });
    }

    return result;
  }

  /**
   * Update cache entries
   */
  private updateCache(cacheKey: string, result: AggregatedPriceResult): void {
    const now = Date.now();

    // Update recent cache
    this.recentCache.set(cacheKey, {
      price: result,
      timestamp: now,
      expiresAt: now + this.config.recentCacheDurationMs,
    });

    // Update stale cache
    this.staleCache.set(cacheKey, {
      price: result,
      timestamp: now,
      expiresAt: now + this.config.staleCacheDurationMs,
    });

    // Clean expired entries
    this.cleanExpiredCache();
  }

  /**
   * Clean expired cache entries
   */
  private cleanExpiredCache(): void {
    const now = Date.now();

    // Clean recent cache
    for (const [key, entry] of this.recentCache.entries()) {
      if (entry.expiresAt < now - this.config.recentCacheDurationMs) {
        this.recentCache.delete(key);
      }
    }

    // Clean stale cache
    for (const [key, entry] of this.staleCache.entries()) {
      if (entry.expiresAt < now - this.config.staleCacheDurationMs) {
        this.staleCache.delete(key);
      }
    }
  }

  /**
   * Update performance metrics
   */
  private updateMetrics(result: AggregatedPriceResult): void {
    // Update tier usage
    const current = this.tierUsageCount.get(result.fallbackTier) || 0;
    this.tierUsageCount.set(result.fallbackTier, current + 1);

    // Update average response time
    const alpha = 0.1; // Smoothing factor
    this.averageResponseTime =
      this.averageResponseTime === 0
        ? result.totalResponseTime
        : (alpha * result.totalResponseTime + (1 - alpha) * this.averageResponseTime);

    // Price state maintained in cache
  }

  /**
   * Add timing to cached result
   */
  private addTimingToResult(result: AggregatedPriceResult, responseTime: number): AggregatedPriceResult {
    return {
      ...result,
      totalResponseTime: responseTime,
    };
  }

  /**
   * Get comprehensive metrics
   */
  getMetrics() {
    const healthReport = this.config.enableHealthMonitoring && this.healthMonitor
      ? this.healthMonitor.getHealthReport()
      : null;

    const reliabilityReport = this.config.enableReliabilityTracking && this.reliabilityTracker
      ? this.reliabilityTracker.getReliabilityReport()
      : null;

    const retryMetrics = this.config.enableRetryLogic && this.retryManager
      ? this.retryManager.getRetryMetrics()
      : null;

    return {
      requestCount: this.requestCount,
      cacheHitCount: this.cacheHitCount,
      cacheHitRate: this.requestCount > 0 ? this.cacheHitCount / this.requestCount : 0,
      averageResponseTime: this.averageResponseTime,
      tierUsage: Object.fromEntries(this.tierUsageCount),
      health: healthReport,
      reliability: reliabilityReport,
      retry: retryMetrics,
      cache: {
        recentSize: this.recentCache.size,
        staleSize: this.staleCache.size,
      },
    };
  }

  /**
   * Shutdown and cleanup
   */
  shutdown(): void {
    // Note: ReliabilityTracker doesn't have a shutdown method in our simplified version
    this.logger.info('EnhancedPriceAggregator shutdown complete');
  }
}
