/**
 * Backward Compatibility Layer for PriceAggregator
 * Allows existing code to use EnhancedPriceAggregator without breaking changes
 */

import { Logger } from '../utils/Logger.js';
import { PublicKey } from '@solana/web3.js';
import { EnhancedPriceAggregator, AggregatedPriceResult } from './EnhancedPriceAggregator.js';

export interface PriceAggregatorConfig {
  cacheDurationMs: number;
  minSources: number;
  maxPriceDeviationPercent: number;
  spreadPercent: number;
  enableCircuitBreaker: boolean;
  circuitBreakerThresholdPercent: number;
}

export interface PriceData {
  price: number;
  source: string;
  timestamp: number;
}

export class PriceAggregator {
  private enhancedAggregator: EnhancedPriceAggregator;
  private logger: Logger;

  constructor(config: PriceAggregatorConfig, logger: Logger) {
    this.logger = logger;
    
    // Convert old config to new enhanced config format
    const enhancedConfig = this.convertToEnhancedConfig(config);
    
    // Initialize EnhancedPriceAggregator with enhanced features enabled
    const finalConfig = {
      ...enhancedConfig,
      enableRetryLogic: true,
      enableHealthMonitoring: true,
      enableReliabilityTracking: true,
      enablePriceValidation: true,
      enableDetailedLogging: true,
      enableMetricsCollection: true,
    };

    this.enhancedAggregator = new EnhancedPriceAggregator(finalConfig, logger);
    
    this.logger.info('PriceAggregator initialized with enhanced features', {
      enhanced: true,
      retryLogic: true,
      healthMonitoring: true,
      reliabilityTracking: true,
      priceValidation: true,
    });
  }

  /**
   * Backward compatible getPrice method
   * Returns data in the same format as the original PriceAggregator
   */
  async getPrice(baseMint: PublicKey, quoteMint: PublicKey): Promise<number | null> {
    try {
      this.logger.debug('Fetching enhanced price', {
        baseMint: baseMint.toString(),
        quoteMint: quoteMint.toString(),
      });

      const result = await this.enhancedAggregator.getPrice(baseMint, quoteMint);
      
      // Return the mid price from the enhanced result
      if (result.midPrice > 0) {
        this.logger.debug('Successfully fetched price via enhanced aggregator', {
          price: result.midPrice,
          tier: result.fallbackTier,
          sources: result.sources.length,
          cacheHit: result.cacheHit,
        });
        return result.midPrice;
      }
      
      return null;
    } catch (error) {
      this.logger.warn('Enhanced price fetch failed, falling back to null', {
        baseMint: baseMint.toString(),
        quoteMint: quoteMint.toString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  /**
   * Get detailed price information (new feature)
   */
  async getDetailedPrice(baseMint: PublicKey, quoteMint: PublicKey): Promise<AggregatedPriceResult | null> {
    try {
      return await this.enhancedAggregator.getPrice(baseMint, quoteMint);
    } catch (error) {
      this.logger.warn('Detailed price fetch failed', {
        baseMint: baseMint.toString(),
        quoteMint: quoteMint.toString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  /**
   * Get health status of all price sources (new feature)
   */
  getHealthStatus(): any {
    return this.enhancedAggregator.getMetrics();
  }

  /**
   * Get price sources performance metrics (new feature)
   */
  getSourceMetrics(): any {
    const metrics = this.enhancedAggregator.getMetrics();
    return {
      health: metrics.health,
      reliability: metrics.reliability,
      retry: metrics.retry,
      tierUsage: metrics.tierUsage,
      cacheHitRate: metrics.cacheHitRate,
      averageResponseTime: metrics.averageResponseTime,
    };
  }

  /**
   * Force refresh price cache (enhanced feature)
   */
  async forceRefresh(baseMint: PublicKey, quoteMint: PublicKey): Promise<number | null> {
    try {
      const result = await this.enhancedAggregator.getPrice(baseMint, quoteMint, true);
      return result?.midPrice || null;
    } catch (error) {
      this.logger.warn('Force refresh failed', {
        baseMint: baseMint.toString(),
        quoteMint: quoteMint.toString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  /**
   * Get aggregated prices from multiple sources (enhanced feature)
   */
  async getAggregatedPrice(baseMint: PublicKey, quoteMint: PublicKey): Promise<PriceData[]> {
    try {
      const result = await this.enhancedAggregator.getPrice(baseMint, quoteMint);
      
      return result.sources.map(source => ({
        price: source.price,
        source: source.source,
        timestamp: source.timestamp,
      }));
    } catch (error) {
      this.logger.warn('Aggregated price fetch failed', {
        baseMint: baseMint.toString(),
        quoteMint: quoteMint.toString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return [];
    }
  }

  /**
   * Shutdown enhanced aggregator (new feature)
   */
  shutdown(): void {
    this.enhancedAggregator.shutdown();
    this.logger.info('Enhanced PriceAggregator shutdown complete');
  }

  /**
   * Convert old PriceAggregatorConfig to EnhancedPriceAggregatorConfig
   */
  private convertToEnhancedConfig(oldConfig: PriceAggregatorConfig): any {
    return {
      // Basic settings from old config
      cacheDurationMs: oldConfig.cacheDurationMs,
      minSources: oldConfig.minSources,
      maxPriceDeviationPercent: oldConfig.maxPriceDeviationPercent,
      spreadPercent: oldConfig.spreadPercent,
      enableCircuitBreaker: oldConfig.enableCircuitBreaker,
      circuitBreakerThresholdPercent: oldConfig.circuitBreakerThresholdPercent,

      // Enhanced features with defaults
      recentCacheDurationMs: 30_000, // 30 seconds
      staleCacheDurationMs: 5 * 60_000, // 5 minutes
      enableRetryLogic: true,
      enableHealthMonitoring: true,
      enableReliabilityTracking: true,
      enablePriceValidation: true,
      
      // Fallback tiers
      tier1MinSources: Math.max(2, oldConfig.minSources),
      tier1Confidence: 0.9,
      tier2Confidence: 0.7,
      tier3Confidence: 0.5,
      tier4Confidence: 0.3,
      
      // Validation
      priceDeviationThresholdPercent: oldConfig.maxPriceDeviationPercent,
      outlierThresholdPercent: 20,
      
      // Monitoring
      enableDetailedLogging: true,
      enableMetricsCollection: true,
      logLevel: 'info',
    };
  }
}

/**
 * Factory function to create PriceAggregator with enhanced features
 */
export function createEnhancedPriceAggregator(
  config: PriceAggregatorConfig, 
  logger: Logger,
  options?: {
    enableAllEnhancedFeatures?: boolean;
    loadFromEnv?: boolean;
  }
): PriceAggregator {
  const aggregator = new PriceAggregator(config, logger);
  
  if (options?.loadFromEnv) {
    logger.info('Loading additional configuration from environment variables');
    // Environment variables will be automatically loaded by the EnhancedPriceAggregator
  }
  
  return aggregator;
}
