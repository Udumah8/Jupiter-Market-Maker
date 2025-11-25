/**
 * Configuration interfaces for the enhanced price feed system
 * Defines all configurable parameters for monitoring, fallback, and aggregation
 */

import { RetryConfig } from '../monitoring/RetryTypes.js';
import { ReliabilityConfig } from '../monitoring/ReliabilityTypes.js';
import { HealthConfig } from '../monitoring/HealthTypes.js';

export interface PriceFeedConfig {
  // Basic price aggregation settings
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
  
  // Fallback tiers configuration
  tier1MinSources: number;
  tier1Confidence: number;
  tier2Confidence: number;
  tier3Confidence: number;
  tier4Confidence: number;
  
  // Validation thresholds
  priceDeviationThresholdPercent: number;
  outlierThresholdPercent: number;
  
  // Monitoring and logging
  enableDetailedLogging: boolean;
  enableMetricsCollection: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  
  // Component-specific configurations
  health?: HealthConfig;
  reliability?: ReliabilityConfig;
  retry?: RetryConfig;
  cache?: CacheConfig;
  
  // Source-specific configurations
  sources?: {
    jupiter?: JupiterConfig;
    pyth?: PythConfig;
    birdeye?: BirdeyeConfig;
    dexscreener?: DexscreenerConfig;
  };
}

export interface CacheConfig {
  maxCacheEntries: number;
  recentCacheTtlMs: number;
  staleCacheTtlMs: number;
  enablePersistence: boolean;
  persistencePath?: string;
}

export interface JupiterConfig {
  enableRateLimiting: boolean;
  maxRequestsPerSecond: number;
  rateLimitWindowMs: number;
  minDelayBetweenRequestsMs: number;
  priceApiUrl?: string;
  quoteApiUrl?: string;
}

export interface PythConfig {
  hermesUrl?: string;
  hermesFallbackUrl?: string;
  cacheTtlMs: number;
  confidenceThreshold: number;
  maxAgeSeconds: number;
  enableSubscriptions: boolean;
}

export interface BirdeyeConfig {
  apiKey?: string;
  baseUrl?: string;
  cacheTtlMs: number;
  timeoutMs: number;
  enablePublicFallback: boolean;
}

export interface DexscreenerConfig {
  baseUrl?: string;
  cacheTtlMs: number;
  timeoutMs: number;
  liquidityThreshold: number;
  volumeThreshold: number;
  maxRetries: number;
  retryDelayMs: number;
}

// Default configurations for each component
export const DEFAULT_CONFIG: PriceFeedConfig = {
  // Basic settings
  cacheDurationMs: 30_000, // 30 seconds
  minSources: 2,
  maxPriceDeviationPercent: 15,
  spreadPercent: 0.5,
  enableCircuitBreaker: true,
  circuitBreakerThresholdPercent: 10,

  // Enhanced features
  recentCacheDurationMs: 30_000, // 30 seconds
  staleCacheDurationMs: 5 * 60_000, // 5 minutes
  enableRetryLogic: true,
  enableHealthMonitoring: true,
  enableReliabilityTracking: true,
  enablePriceValidation: true,
  
  // Fallback tiers
  tier1MinSources: 2,
  tier1Confidence: 0.9,
  tier2Confidence: 0.7,
  tier3Confidence: 0.5,
  tier4Confidence: 0.3,
  
  // Validation
  priceDeviationThresholdPercent: 15,
  outlierThresholdPercent: 20,
  
  // Monitoring
  enableDetailedLogging: true,
  enableMetricsCollection: true,
  logLevel: 'info',

  // Component configs
  cache: {
    maxCacheEntries: 1000,
    recentCacheTtlMs: 30_000,
    staleCacheTtlMs: 5 * 60_000,
    enablePersistence: false,
  },

  sources: {
    jupiter: {
      enableRateLimiting: true,
      maxRequestsPerSecond: 5,
      rateLimitWindowMs: 1000,
      minDelayBetweenRequestsMs: 200,
    },
    pyth: {
      cacheTtlMs: 4_000,
      confidenceThreshold: 0.05,
      maxAgeSeconds: 90,
      enableSubscriptions: true,
    },
    birdeye: {
      cacheTtlMs: 4_000,
      timeoutMs: 8_000,
      enablePublicFallback: true,
    },
    dexscreener: {
      cacheTtlMs: 5_000,
      timeoutMs: 8_000,
      liquidityThreshold: 10_000,
      volumeThreshold: 5_000,
      maxRetries: 3,
      retryDelayMs: 100,
    },
  },
};

// Environment variable mapping
export const ENV_VAR_MAPPING: Record<string, keyof PriceFeedConfig> = {
  // Basic settings
  PRICE_FEED_CACHE_DURATION_MS: 'cacheDurationMs',
  PRICE_FEED_MIN_SOURCES: 'minSources',
  PRICE_FEED_MAX_DEVIATION_PERCENT: 'maxPriceDeviationPercent',
  PRICE_FEED_SPREAD_PERCENT: 'spreadPercent',
  PRICE_FEED_ENABLE_CIRCUIT_BREAKER: 'enableCircuitBreaker',
  PRICE_FEED_CIRCUIT_BREAKER_THRESHOLD: 'circuitBreakerThresholdPercent',

  // Enhanced features
  PRICE_FEED_RECENT_CACHE_DURATION_MS: 'recentCacheDurationMs',
  PRICE_FEED_STALE_CACHE_DURATION_MS: 'staleCacheDurationMs',
  PRICE_FEED_ENABLE_RETRY_LOGIC: 'enableRetryLogic',
  PRICE_FEED_ENABLE_HEALTH_MONITORING: 'enableHealthMonitoring',
  PRICE_FEED_ENABLE_RELIABILITY_TRACKING: 'enableReliabilityTracking',
  PRICE_FEED_ENABLE_PRICE_VALIDATION: 'enablePriceValidation',

  // Fallback tiers
  PRICE_FEED_TIER1_MIN_SOURCES: 'tier1MinSources',
  PRICE_FEED_TIER1_CONFIDENCE: 'tier1Confidence',
  PRICE_FEED_TIER2_CONFIDENCE: 'tier2Confidence',
  PRICE_FEED_TIER3_CONFIDENCE: 'tier3Confidence',
  PRICE_FEED_TIER4_CONFIDENCE: 'tier4Confidence',

  // Validation
  PRICE_FEED_DEVIATION_THRESHOLD_PERCENT: 'priceDeviationThresholdPercent',
  PRICE_FEED_OUTLIER_THRESHOLD_PERCENT: 'outlierThresholdPercent',

  // Monitoring
  PRICE_FEED_ENABLE_DETAILED_LOGGING: 'enableDetailedLogging',
  PRICE_FEED_ENABLE_METRICS_COLLECTION: 'enableMetricsCollection',
  PRICE_FEED_LOG_LEVEL: 'logLevel',
};

// Nested environment variable mapping for source-specific configurations
export const NESTED_ENV_VAR_MAPPING: Record<string, string> = {
  // Pyth configuration
  PYTH_HERMES_URL: 'sources.pyth.hermesUrl',
  PYTH_HERMES_FALLBACK_URL: 'sources.pyth.hermesFallbackUrl',
  
  // Birdeye configuration
  BIRDEYE_API_KEY: 'sources.birdeye.apiKey',
};
