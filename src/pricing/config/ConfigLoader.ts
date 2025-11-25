/**
 * Configuration loader for the enhanced price feed system
 * Handles environment variable parsing and configuration merging
 */

import { PriceFeedConfig, DEFAULT_CONFIG, ENV_VAR_MAPPING, NESTED_ENV_VAR_MAPPING } from './PriceFeedConfig.js';

export interface ConfigLoaderOptions {
  envVarPrefix?: string;
  allowOverrides?: boolean;
  validateConfig?: boolean;
}

export class ConfigLoader {
  private options: ConfigLoaderOptions;

  constructor(options: ConfigLoaderOptions = {}) {
    this.options = {
      envVarPrefix: '',
      allowOverrides: true,
      validateConfig: true,
      ...options,
    };
  }

  /**
   * Load configuration from environment variables
   */
  loadConfig(): PriceFeedConfig {
    const config = this.deepClone(DEFAULT_CONFIG);
    
    // Load top-level environment variables
    this.loadTopLevelEnvVars(config);
    
    // Load nested environment variables
    this.loadNestedEnvVars(config);
    
    // Apply custom environment variable prefix if specified
    if (this.options.envVarPrefix) {
      this.loadPrefixedEnvVars(config, this.options.envVarPrefix);
    }
    
    // Validate configuration if enabled
    if (this.options.validateConfig) {
      this.validateConfig(config);
    }
    
    return config;
  }

  /**
   * Load top-level environment variables
   */
  private loadTopLevelEnvVars(config: PriceFeedConfig): void {
    for (const [envVar, configPath] of Object.entries(ENV_VAR_MAPPING)) {
      const envValue = process.env[envVar];
      if (envValue !== undefined) {
        this.setConfigValue(config, configPath, this.parseEnvValue(envValue, configPath));
      }
    }
  }

  /**
   * Load nested environment variables
   */
  private loadNestedEnvVars(config: PriceFeedConfig): void {
    for (const [envVar, nestedPath] of Object.entries(NESTED_ENV_VAR_MAPPING)) {
      const envValue = process.env[envVar];
      if (envValue !== undefined) {
        this.setNestedConfigValue(config, nestedPath, envValue);
      }
    }
  }

  /**
   * Load configuration with custom prefix
   */
  private loadPrefixedEnvVars(config: PriceFeedConfig, prefix: string): void {
    const prefixedEnvVars = Object.keys(process.env).filter(envVar => 
      envVar.startsWith(prefix)
    );
    
    for (const envVar of prefixedEnvVars) {
      const configKey = envVar.replace(prefix, '').toLowerCase();
      const envValue = process.env[envVar];
      
      if (envValue !== undefined && this.isValidConfigKey(configKey)) {
        this.setConfigValue(config, configKey as keyof PriceFeedConfig, this.parseEnvValue(envValue, configKey));
      }
    }
  }

  /**
   * Parse environment variable value based on expected type
   */
  private parseEnvValue(value: string, configPath?: string): any {
    // Boolean values
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
    if (value.toLowerCase() === '1') return true;
    if (value.toLowerCase() === '0') return false;

    // Numeric values
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    if (/^\d*\.\d+$/.test(value)) return parseFloat(value);

    // Log level
    if (configPath === 'logLevel' && ['debug', 'info', 'warn', 'error'].includes(value)) {
      return value;
    }

    // Return as string for other values
    return value;
  }

  /**
   * Set nested configuration value
   */
  private setNestedConfigValue(config: any, path: string, value: any): void {
    const keys = path.split('.');
    let current = config;
    
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!current[key]) {
        current[key] = {};
      }
      current = current[key];
    }
    
    const lastKey = keys[keys.length - 1];
    current[lastKey] = value;
  }

  /**
   * Set configuration value at path
   */
  private setConfigValue(config: any, path: keyof PriceFeedConfig, value: any): void {
    config[path] = value;
  }

  /**
   * Deep clone an object
   */
  private deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
  }

  /**
   * Check if config key is valid
   */
  private isValidConfigKey(key: string): boolean {
    return Object.keys(DEFAULT_CONFIG).includes(key);
  }

  /**
   * Validate configuration
   */
  private validateConfig(config: PriceFeedConfig): void {
    // Validate basic numeric ranges
    if (config.cacheDurationMs < 1000) {
      throw new Error('cacheDurationMs must be at least 1000ms');
    }
    
    if (config.minSources < 1 || config.minSources > 10) {
      throw new Error('minSources must be between 1 and 10');
    }
    
    if (config.maxPriceDeviationPercent < 0 || config.maxPriceDeviationPercent > 100) {
      throw new Error('maxPriceDeviationPercent must be between 0 and 100');
    }
    
    if (config.recentCacheDurationMs >= config.staleCacheDurationMs) {
      throw new Error('recentCacheDurationMs must be less than staleCacheDurationMs');
    }
    
    // Validate confidence levels
    const confidences = [
      config.tier1Confidence,
      config.tier2Confidence,
      config.tier3Confidence,
      config.tier4Confidence
    ];
    
    for (const confidence of confidences) {
      if (confidence < 0 || confidence > 1) {
        throw new Error('Confidence levels must be between 0 and 1');
      }
    }
    
    // Validate that confidences are in descending order
    for (let i = 1; i < confidences.length; i++) {
      if (confidences[i] > confidences[i - 1]) {
        throw new Error('Confidence levels must be in descending order (tier1 >= tier2 >= tier3 >= tier4)');
      }
    }
  }

  /**
   * Get configuration for specific component
   */
  getComponentConfig(config: PriceFeedConfig, component: 'jupiter' | 'pyth' | 'birdeye' | 'dexscreener'): any {
    return config.sources?.[component] || {};
  }

  /**
   * Merge custom configuration with defaults
   */
  mergeConfig(customConfig: Partial<PriceFeedConfig>): PriceFeedConfig {
    const config = this.deepClone(DEFAULT_CONFIG);
    
    // Merge top-level properties
    for (const [key, value] of Object.entries(customConfig)) {
      if (value !== undefined) {
        (config as any)[key] = value;
      }
    }
    
    return config;
  }

  /**
   * Get environment variable description for help/debugging
   */
  getEnvironmentVariableHelp(): Record<string, string> {
    return {
      // Basic settings
      'PRICE_FEED_CACHE_DURATION_MS': 'Cache duration in milliseconds (default: 30000)',
      'PRICE_FEED_MIN_SOURCES': 'Minimum number of sources required (default: 2)',
      'PRICE_FEED_MAX_DEVIATION_PERCENT': 'Maximum price deviation percentage between sources (default: 15)',
      
      // Enhanced features
      'PRICE_FEED_ENABLE_HEALTH_MONITORING': 'Enable health monitoring for price sources (default: true)',
      'PRICE_FEED_ENABLE_RELIABILITY_TRACKING': 'Enable reliability tracking (default: true)',
      'PRICE_FEED_ENABLE_RETRY_LOGIC': 'Enable retry logic for failed requests (default: true)',
      
      // Source-specific
      'PYTH_HERMES_URL': 'Primary Pyth Hermes endpoint URL',
      'PYTH_HERMES_FALLBACK_URL': 'Fallback Pyth Hermes endpoint URL',
      'BIRDEYE_API_KEY': 'Birdeye API key for authenticated requests',
    };
  }
}

/**
 * Helper function to load price feed configuration
 */
export function loadPriceFeedConfig(options?: ConfigLoaderOptions): PriceFeedConfig {
  const loader = new ConfigLoader(options);
  return loader.loadConfig();
}
