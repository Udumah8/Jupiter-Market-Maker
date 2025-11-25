/**
 * Production-ready Logger
 * Structured logging with Winston
 */

import winston from 'winston';

export interface LogContext {
  [key: string]: any;
}

export class Logger {
  private logger: winston.Logger;

  constructor(level: string = 'info') {
    this.logger = winston.createLogger({
      level,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { service: 'solana-market-maker' },
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        }),
        new winston.transports.File({
          filename: 'logs/bot.log',
          maxsize: 10 * 1024 * 1024, // 10MB
          maxFiles: 5,
        })
      ],
    });
  }

  debug(message: string, context?: LogContext): void {
    this.logger.debug(message, context);
  }

  info(message: string, context?: LogContext): void {
    this.logger.info(message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.logger.warn(message, context);
  }

  error(message: string, context?: LogContext): void {
    this.logger.error(message, context);
  }

  // Specialized logging methods
  logTrade(trade: {
    success: boolean;
    type: string;
    wallet: string;
    price?: number;
    size?: number;
    pnl?: number;
  }): void {
    this.logger.info('Trade executed', {
      ...trade,
      timestamp: new Date().toISOString(),
    });
  }

  logError(error: Error, context?: LogContext): void {
    this.logger.error('Error occurred', {
      message: error.message,
      stack: error.stack,
      ...context,
    });
  }

  logPerformance(operation: string, duration: number, context?: LogContext): void {
    this.logger.debug('Performance measurement', {
      operation,
      duration,
      ...context,
    });
  }
}

// Export a default logger instance for backward compatibility
export const logger = new Logger('info');