/**
 * Rate Limiter Utility
 * Prevents API rate limit errors by throttling requests
 */

export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
  minDelayMs?: number;
}

export class RateLimiter {
  private requests: number[] = [];
  private config: RateLimiterConfig;
  private lastRequestTime: number = 0;

  constructor(config: RateLimiterConfig) {
    this.config = config;
  }

  /**
   * Wait if necessary to respect rate limits
   */
  async waitForSlot(): Promise<void> {
    const now = Date.now();
    
    // Remove old requests outside the window
    this.requests = this.requests.filter(
      time => now - time < this.config.windowMs
    );

    // Check if we've hit the limit
    if (this.requests.length >= this.config.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = this.config.windowMs - (now - oldestRequest);
      
      if (waitTime > 0) {
        await this.sleep(waitTime);
        return this.waitForSlot(); // Recursive call after waiting
      }
    }

    // Enforce minimum delay between requests
    if (this.config.minDelayMs) {
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < this.config.minDelayMs) {
        await this.sleep(this.config.minDelayMs - timeSinceLastRequest);
      }
    }

    // Record this request
    this.requests.push(Date.now());
    this.lastRequestTime = Date.now();
  }

  /**
   * Execute a function with rate limiting
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.waitForSlot();
    return fn();
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Reset the rate limiter
   */
  reset(): void {
    this.requests = [];
    this.lastRequestTime = 0;
  }

  /**
   * Get current request count in window
   */
  getCurrentCount(): number {
    const now = Date.now();
    this.requests = this.requests.filter(
      time => now - time < this.config.windowMs
    );
    return this.requests.length;
  }
}
