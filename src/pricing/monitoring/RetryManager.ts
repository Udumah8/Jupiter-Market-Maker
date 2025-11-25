/**
 * RetryManager class for handling retry logic with exponential backoff
 * Implements retry attempts, rate limiting, and source cooldown mechanisms
 */

import { Logger } from '../../utils/Logger.js';
import { RetryConfig, RetryResult, SourceStatus } from './RetryTypes.js';

export class RetryManager {
  private sources: Map<string, SourceStatus> = new Map();
  private logger: Logger;
  private config: RetryConfig;
  
  // Retry metrics
  private totalRetries = 0;
  private successfulRetries = 0;
  private failedRetries = 0;
  private totalAttempts = 0;

  constructor(logger: Logger, config: Partial<RetryConfig> = {}) {
    this.logger = logger;
    this.config = {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 4000,
      backoffMultiplier: 2,
      jitter: true,
      cooldownPeriodMs: 60000, // 1 minute default cooldown
      ...config,
    };
    
    this.logger.info('RetryManager initialized', {
      maxAttempts: this.config.maxAttempts,
      baseDelayMs: this.config.baseDelayMs,
      cooldownPeriodMs: this.config.cooldownPeriodMs,
    });
  }

  /**
   * Execute a function with retry logic
   */
  async executeWithRetry<T>(
    source: string,
    operation: () => Promise<T>,
    operationName: string = 'operation'
  ): Promise<RetryResult<T>> {
    const startTime = Date.now();
    this.totalRetries++;
    
    // Check if source is in cooldown
    if (this.isSourceInCooldown(source)) {
      this.logger.debug(`Source ${source} is in cooldown, skipping retry`, {
        source,
        operation: operationName,
      });
      
      this.failedRetries++;
      return {
        success: false,
        error: new Error(`Source ${source} is in cooldown`),
        attempts: 0,
        totalTime: Date.now() - startTime,
        lastAttemptTime: Date.now(),
      };
    }
    
    let lastError: Error | undefined;
    
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      this.totalAttempts++;
      
      try {
        this.logger.debug(`Attempting ${operationName} for source ${source}`, {
          source,
          operation: operationName,
          attempt,
          maxAttempts: this.config.maxAttempts,
        });
        
        // Update source status
        this.updateSourceStatus(source, attempt);
        
        // Execute the operation
        const result = await operation();
        
        // Record successful retry
        if (attempt > 1) {
          this.successfulRetries++;
          this.logger.info(`Retry successful for ${operationName} on source ${source}`, {
            source,
            operation: operationName,
            attempts: attempt,
            timeSaved: this.calculateTimeSaved(attempt),
          });
        }
        
        // Clear cooldown status on success
        this.clearSourceCooldown(source);
        
        return {
          success: true,
          data: result,
          attempts: attempt,
          totalTime: Date.now() - startTime,
          lastAttemptTime: Date.now(),
        };
        
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');
        
        this.logger.warn(`${operationName} failed for source ${source}`, {
          source,
          operation: operationName,
          attempt,
          error: lastError.message,
          isRetryable: this.isRetryableError(lastError),
        });
        
        // Check if error is retryable
        if (!this.isRetryableError(lastError) || attempt === this.config.maxAttempts) {
          break;
        }
        
        // Wait before next attempt (with backoff)
        const delay = this.calculateBackoffDelay(attempt);
        await this.sleep(delay);
      }
    }
    
    // All attempts failed
    this.failedRetries++;
    this.handleFailedRetry(source, lastError!);
    
    return {
      success: false,
      error: lastError,
      attempts: this.config.maxAttempts,
      totalTime: Date.now() - startTime,
      lastAttemptTime: Date.now(),
    };
  }

  /**
   * Check if a source is currently in cooldown
   */
  isSourceInCooldown(source: string): boolean {
    const status = this.sources.get(source);
    if (!status) return false;
    
    const now = Date.now();
    return status.isInCooldown && (status.cooldownEndTime || 0) > now;
  }

  /**
   * Get cooldown status for a source
   */
  getSourceCooldownStatus(source: string): number {
    const status = this.sources.get(source);
    if (!status || !status.cooldownEndTime) return 0;
    
    const remaining = status.cooldownEndTime - Date.now();
    return Math.max(0, remaining);
  }

  /**
   * Manually trigger cooldown for a source
   */
  triggerCooldown(source: string, customCooldownMs?: number): void {
    const cooldownMs = customCooldownMs || this.config.cooldownPeriodMs;
    const cooldownEndTime = Date.now() + cooldownMs;
    
    const status: SourceStatus = {
      source,
      lastAttempt: Date.now(),
      isInCooldown: true,
      cooldownEndTime,
      consecutiveFailures: (this.sources.get(source)?.consecutiveFailures || 0) + 1,
    };
    
    this.sources.set(source, status);
    
    this.logger.warn(`Manual cooldown triggered for source ${source}`, {
      source,
      cooldownMs,
      consecutiveFailures: status.consecutiveFailures,
    });
  }

  /**
   * Clear cooldown for a source
   */
  clearSourceCooldown(source: string): void {
    const status = this.sources.get(source);
    if (status) {
      status.isInCooldown = false;
      status.cooldownEndTime = undefined;
      status.consecutiveFailures = 0;
      this.sources.set(source, status);
    }
  }

  /**
   * Get retry metrics
   */
  getRetryMetrics() {
    const sourceCooldowns = Array.from(this.sources.values()).map(status => ({
      ...status,
      remainingCooldownTime: this.getSourceCooldownStatus(status.source),
    }));
    
    return {
      totalRetries: this.totalRetries,
      successfulRetries: this.successfulRetries,
      failedRetries: this.failedRetries,
      averageAttempts: this.totalRetries > 0 ? this.totalAttempts / this.totalRetries : 0,
      sourceCooldowns,
    };
  }

  /**
   * Reset all metrics and cooldown states
   */
  reset(): void {
    this.totalRetries = 0;
    this.successfulRetries = 0;
    this.failedRetries = 0;
    this.totalAttempts = 0;
    this.sources.clear();
    
    this.logger.info('RetryManager reset all metrics and cooldown states');
  }

  /**
   * Private helper to update source status
   */
  private updateSourceStatus(source: string, attempt: number): void {
    const status: SourceStatus = {
      source,
      lastAttempt: Date.now(),
      isInCooldown: false,
      consecutiveFailures: attempt - 1, // Only count actual failures
    };
    
    this.sources.set(source, status);
  }

  /**
   * Private helper to handle failed retry
   */
  private handleFailedRetry(source: string, error: Error): void {
    // Trigger cooldown for frequently failing sources
    if (this.isRetryableError(error) && this.shouldTriggerCooldown(source)) {
      this.triggerCooldown(source);
    }
    
    this.logger.error(`All retry attempts failed for source ${source}`, {
      source,
      maxAttempts: this.config.maxAttempts,
      error: error.message,
      shouldCooldown: this.shouldTriggerCooldown(source),
    });
  }

  /**
   * Check if an error is retryable
   */
  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    
    // Network-related errors are retryable
    if (message.includes('network') || 
        message.includes('timeout') ||
        message.includes('econnreset') ||
        message.includes('econnrefused') ||
        message.includes('enotfound') ||
        message.includes('econnaborted')) {
      return true;
    }
    
    // Rate limiting (HTTP 429) is retryable
    if (message.includes('rate limit') || 
        message.includes('429') ||
        message.includes('too many requests')) {
      return true;
    }
    
    // Server errors (5xx) are retryable
    if (message.includes('500') ||
        message.includes('502') ||
        message.includes('503') ||
        message.includes('504')) {
      return true;
    }
    
    // Authentication errors are not retryable
    if (message.includes('401') ||
        message.includes('403') ||
        message.includes('auth') ||
        message.includes('unauthorized')) {
      return false;
    }
    
    // Client errors (4xx) are not retryable
    if (message.includes('400') ||
        message.includes('404') ||
        message.includes('422')) {
      return false;
    }
    
    // Default to retryable for unknown errors
    return true;
  }

  /**
   * Calculate backoff delay with optional jitter
   */
  private calculateBackoffDelay(attempt: number): number {
    let delay = this.config.baseDelayMs * Math.pow(this.config.backoffMultiplier, attempt - 1);
    
    // Cap at maximum delay
    delay = Math.min(delay, this.config.maxDelayMs);
    
    // Add jitter to prevent thundering herd
    if (this.config.jitter) {
      const jitterRange = delay * 0.1; // 10% jitter
      delay += (Math.random() - 0.5) * 2 * jitterRange;
    }
    
    return Math.max(0, delay);
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Calculate time saved by retrying vs giving up immediately
   */
  private calculateTimeSaved(attempts: number): number {
    const baseDelay = this.config.baseDelayMs;
    let timeSaved = 0;
    
    for (let i = 1; i < attempts; i++) {
      timeSaved += baseDelay * Math.pow(this.config.backoffMultiplier, i - 1);
    }
    
    return timeSaved;
  }

  /**
   * Determine if a source should be put in cooldown
   */
  private shouldTriggerCooldown(source: string): boolean {
    const status = this.sources.get(source);
    if (!status) return false;
    
    // Trigger cooldown after multiple consecutive failures
    return status.consecutiveFailures >= 3;
  }
}
