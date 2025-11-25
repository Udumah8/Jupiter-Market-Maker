/**
 * HealthMonitor class for tracking price feed source health status
 * Implements health monitoring with failure thresholds and auto-recovery
 */

import { Logger } from '../../utils/Logger.js';
import { SourceHealth, HealthConfig, HealthReport } from './HealthTypes.js';

export class HealthMonitor {
  private sources: Map<string, SourceHealth> = new Map();
  private logger: Logger;
  private config: HealthConfig;

  constructor(logger: Logger, config: Partial<HealthConfig> = {}) {
    this.logger = logger;
    this.config = {
      failureThreshold: 5,
      successRecoveryThreshold: 3,
      checkIntervalMs: 60000, // 1 minute
      ...config,
    };
    
    this.logger.info('HealthMonitor initialized', {
      failureThreshold: this.config.failureThreshold,
      successRecoveryThreshold: this.config.successRecoveryThreshold,
    });
  }

  /**
   * Record a successful request for a source
   */
  recordSuccess(source: string): void {
    const health = this.getOrCreateSourceHealth(source);
    
    health.totalRequests++;
    health.successfulRequests++;
    health.consecutiveSuccesses++;
    health.consecutiveFailures = 0; // Reset failure streak
    health.lastSuccessTime = Date.now();
    health.lastCheckedTime = Date.now();
    
    // Check if source recovered from unhealthy state
    if (!health.isHealthy && health.consecutiveSuccesses >= this.config.successRecoveryThreshold) {
      health.isHealthy = true;
      this.logger.info(`Source ${source} recovered and is now healthy`, {
        consecutiveSuccesses: health.consecutiveSuccesses,
        successRate: this.calculateSuccessRate(health),
      });
    }
    
    this.sources.set(source, health);
  }

  /**
   * Record a failed request for a source
   */
  recordFailure(source: string): void {
    const health = this.getOrCreateSourceHealth(source);
    
    health.totalRequests++;
    health.failedRequests++;
    health.consecutiveFailures++;
    health.consecutiveSuccesses = 0; // Reset success streak
    health.lastFailureTime = Date.now();
    health.lastCheckedTime = Date.now();
    
    // Check if source became unhealthy
    if (health.isHealthy && health.consecutiveFailures >= this.config.failureThreshold) {
      health.isHealthy = false;
      this.logger.warn(`Source ${source} became unhealthy`, {
        consecutiveFailures: health.consecutiveFailures,
        failureRate: this.calculateFailureRate(health),
      });
    }
    
    this.sources.set(source, health);
  }

  /**
   * Check if a source is currently healthy
   */
  isSourceHealthy(source: string): boolean {
    const health = this.sources.get(source);
    return health ? health.isHealthy : true; // Default to healthy for unknown sources
  }

  /**
   * Get health status for a specific source
   */
  getSourceHealth(source: string): SourceHealth | null {
    return this.sources.get(source) || null;
  }

  /**
   * Generate comprehensive health report
   */
  getHealthReport(): HealthReport {
    const allSources = Array.from(this.sources.values());
    
    let healthyCount = 0;
    let degradedCount = 0;
    let unhealthyCount = 0;
    
    for (const health of allSources) {
      if (health.isHealthy && health.consecutiveSuccesses >= this.config.successRecoveryThreshold) {
        healthyCount++;
      } else if (health.isHealthy && health.consecutiveFailures > 0) {
        degradedCount++;
      } else {
        unhealthyCount++;
      }
    }
    
    // Determine overall health
    let overallHealth: 'healthy' | 'degraded' | 'unhealthy';
    if (unhealthyCount === allSources.length) {
      overallHealth = 'unhealthy';
    } else if (healthyCount > degradedCount + unhealthyCount) {
      overallHealth = 'healthy';
    } else {
      overallHealth = 'degraded';
    }
    
    return {
      overallHealth,
      sources: allSources,
      totalSources: allSources.length,
      healthySources: healthyCount,
      degradedSources: degradedCount,
      unhealthySources: unhealthyCount,
      timestamp: Date.now(),
    };
  }

  /**
   * Reset health status for all sources (useful for testing)
   */
  resetAll(): void {
    this.sources.clear();
    this.logger.info('HealthMonitor reset all sources');
  }

  /**
   * Get list of healthy sources
   */
  getHealthySources(): string[] {
    const healthySources: string[] = [];
    
    for (const [source, health] of this.sources.entries()) {
      if (health.isHealthy) {
        healthySources.push(source);
      }
    }
    
    return healthySources;
  }

  /**
   * Get list of unhealthy sources
   */
  getUnhealthySources(): string[] {
    const unhealthySources: string[] = [];
    
    for (const [source, health] of this.sources.entries()) {
      if (!health.isHealthy) {
        unhealthySources.push(source);
      }
    }
    
    return unhealthySources;
  }

  /**
   * Private helper to get or create source health object
   */
  private getOrCreateSourceHealth(source: string): SourceHealth {
    let health = this.sources.get(source);
    
    if (!health) {
      health = {
        source,
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        isHealthy: true, // Default to healthy for new sources
        lastCheckedTime: Date.now(),
      };
    }
    
    return health;
  }

  /**
   * Calculate success rate for a source
   */
  private calculateSuccessRate(health: SourceHealth): number {
    if (health.totalRequests === 0) return 1.0;
    return health.successfulRequests / health.totalRequests;
  }

  /**
   * Calculate failure rate for a source
   */
  private calculateFailureRate(health: SourceHealth): number {
    if (health.totalRequests === 0) return 0.0;
    return health.failedRequests / health.totalRequests;
  }
}
