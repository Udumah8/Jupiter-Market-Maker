/**
 * Enhanced PriceFeedError class with error classification for better retry handling
 */

export enum PriceErrorType {
  NETWORK_ERROR = 'NETWORK_ERROR',
  RATE_LIMIT = 'RATE_LIMIT',
  INVALID_RESPONSE = 'INVALID_RESPONSE',
  TIMEOUT = 'TIMEOUT',
  AUTH_ERROR = 'AUTH_ERROR',
  NO_DATA = 'NO_DATA',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE'
}

export interface PriceFeedErrorOptions {
  source?: string;
  type: PriceErrorType;
  retryable?: boolean;
  statusCode?: number;
  details?: Record<string, any>;
}

export class PriceFeedError extends Error {
  public readonly source: string;
  public readonly type: PriceErrorType;
  public readonly retryable: boolean;
  public readonly statusCode?: number;
  public readonly details?: Record<string, any>;

  constructor(message: string, options: PriceFeedErrorOptions) {
    super(message);
    this.name = 'PriceFeedError';
    
    this.source = options.source || 'unknown';
    this.type = options.type;
    this.retryable = options.retryable ?? this.isRetryableByType(options.type);
    this.statusCode = options.statusCode;
    this.details = options.details;

    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PriceFeedError);
    }
  }

  /**
   * Determine if error is retryable based on error type
   */
  private isRetryableByType(type: PriceErrorType): boolean {
    switch (type) {
      case PriceErrorType.NETWORK_ERROR:
      case PriceErrorType.RATE_LIMIT:
      case PriceErrorType.TIMEOUT:
      case PriceErrorType.SERVICE_UNAVAILABLE:
        return true;
      case PriceErrorType.INVALID_RESPONSE:
      case PriceErrorType.AUTH_ERROR:
      case PriceErrorType.NO_DATA:
      case PriceErrorType.VALIDATION_ERROR:
        return false;
      default:
        return true; // Default to retryable for unknown errors
    }
  }

  /**
   * Create error from HTTP response
   */
  static fromHttpResponse(
    source: string,
    statusCode: number,
    responseText: string,
    url?: string
  ): PriceFeedError {
    let type: PriceErrorType;
    let retryable: boolean;

    switch (statusCode) {
      case 429:
        type = PriceErrorType.RATE_LIMIT;
        retryable = true;
        break;
      case 401:
      case 403:
        type = PriceErrorType.AUTH_ERROR;
        retryable = false;
        break;
      case 404:
      case 422:
        type = PriceErrorType.VALIDATION_ERROR;
        retryable = false;
        break;
      case 500:
      case 502:
      case 503:
      case 504:
        type = PriceErrorType.SERVICE_UNAVAILABLE;
        retryable = true;
        break;
      default:
        if (statusCode >= 500) {
          type = PriceErrorType.SERVICE_UNAVAILABLE;
          retryable = true;
        } else if (statusCode >= 400) {
          type = PriceErrorType.VALIDATION_ERROR;
          retryable = false;
        } else {
          type = PriceErrorType.NETWORK_ERROR;
          retryable = true;
        }
    }

    return new PriceFeedError(
      `${source} HTTP ${statusCode}: ${responseText}`,
      {
        source,
        type,
        retryable,
        statusCode,
        details: { url, responseText }
      }
    );
  }

  /**
   * Create error from network/timeout issues
   */
  static fromNetworkError(
    source: string,
    error: Error | string,
    operation: string = 'request'
  ): PriceFeedError {
    const message = typeof error === 'string' ? error : error.message;
    const isTimeout = message.toLowerCase().includes('timeout');

    return new PriceFeedError(
      `${source} ${operation} failed: ${message}`,
      {
        source,
        type: isTimeout ? PriceErrorType.TIMEOUT : PriceErrorType.NETWORK_ERROR,
        retryable: true,
        details: { originalError: message, operation }
      }
    );
  }

  /**
   * Create error for invalid response data
   */
  static fromInvalidResponse(
    source: string,
    reason: string,
    responseData?: any
  ): PriceFeedError {
    return new PriceFeedError(
      `${source} invalid response: ${reason}`,
      {
        source,
        type: PriceErrorType.INVALID_RESPONSE,
        retryable: false,
        details: { reason, responseData }
      }
    );
  }

  /**
   * Create error when no data is available
   */
  static fromNoData(
    source: string,
    symbol?: string,
    reason?: string
  ): PriceFeedError {
    return new PriceFeedError(
      `${source} no data available${symbol ? ` for ${symbol}` : ''}${reason ? `: ${reason}` : ''}`,
      {
        source,
        type: PriceErrorType.NO_DATA,
        retryable: false,
        details: { symbol, reason }
      }
    );
  }

  /**
   * Get user-friendly error message
   */
  getFriendlyMessage(): string {
    switch (this.type) {
      case PriceErrorType.NETWORK_ERROR:
        return `Network connectivity issue with ${this.source}`;
      case PriceErrorType.RATE_LIMIT:
        return `Rate limit exceeded for ${this.source}`;
      case PriceErrorType.TIMEOUT:
        return `Request timeout for ${this.source}`;
      case PriceErrorType.AUTH_ERROR:
        return `Authentication failed for ${this.source}`;
      case PriceErrorType.SERVICE_UNAVAILABLE:
        return `Service unavailable from ${this.source}`;
      case PriceErrorType.INVALID_RESPONSE:
        return `Invalid data received from ${this.source}`;
      case PriceErrorType.NO_DATA:
        return `No price data available from ${this.source}`;
      case PriceErrorType.VALIDATION_ERROR:
        return `Request validation failed for ${this.source}`;
      default:
        return `Error occurred with ${this.source}`;
    }
  }
}
