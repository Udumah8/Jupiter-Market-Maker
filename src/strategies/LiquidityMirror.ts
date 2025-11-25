/**
 * Liquidity Mirroring Strategy
 * Mirrors order book depth from major DEXs to appear as natural liquidity
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { Logger } from '../utils/Logger.js';
import { RateLimiter } from '../utils/RateLimiter.js';
import fetch from 'node-fetch';

export interface OrderBookLevel {
  price: number;
  size: number;
  count: number;
}

export interface OrderBookDepth {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  spread: number;
  midPrice: number;
  timestamp: number;
}

export interface MirrorConfig {
  enabled: boolean;
  depthLevels: number; // How many levels to mirror
  sizeMultiplier: number; // Multiply mirrored size by this (e.g., 0.1 = 10% of original)
  randomizationPercent: number; // Add randomization to avoid detection
  minOrderSize: number; // Minimum order size
  maxOrderSize: number; // Maximum order size
  updateInterval: number; // How often to update mirror (ms)
}

export interface MirrorOrder {
  price: number;
  size: number;
  side: 'bid' | 'ask';
  level: number;
}

export class LiquidityMirror {
  private logger: Logger;
  private config: MirrorConfig;
  private lastOrderBook: OrderBookDepth | null = null;
  private lastUpdate: number = 0;
  private rateLimiter: RateLimiter;

  constructor(_connection: Connection, config: MirrorConfig, logger: Logger) {
    // Connection stored for future DEX integration
    this.config = config;
    this.logger = logger;
    // Rate limiter for Jupiter API calls
    this.rateLimiter = new RateLimiter({
      maxRequests: 5,
      windowMs: 1000,
      minDelayMs: 200,
    });
  }

  /**
   * Analyze order book depth from Jupiter or other DEX
   */
  async analyzeOrderBook(
    baseMint: PublicKey,
    quoteMint: PublicKey
  ): Promise<OrderBookDepth | null> {
    try {
      // Check if we need to update
      const now = Date.now();
      if (
        this.lastOrderBook &&
        now - this.lastUpdate < this.config.updateInterval
      ) {
        return this.lastOrderBook;
      }

      // In production, this would fetch from Jupiter, Serum, or other DEX
      // For now, we'll create a simulated order book structure
      this.logger.debug('Analyzing order book', {
        baseMint: baseMint.toString(),
        quoteMint: quoteMint.toString(),
      });

      // Fetch order book from Jupiter aggregated liquidity
      const orderBook = await this.fetchOrderBookFromDEX(baseMint, quoteMint);

      this.lastOrderBook = orderBook;
      this.lastUpdate = now;

      return orderBook;
    } catch (error) {
      this.logger.error('Failed to analyze order book', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  /**
   * Generate mirror orders based on order book depth
   */
  generateMirrorOrders(orderBook: OrderBookDepth): MirrorOrder[] {
    const mirrorOrders: MirrorOrder[] = [];

    // Mirror bid orders
    for (let i = 0; i < Math.min(this.config.depthLevels, orderBook.bids.length); i++) {
      const level = orderBook.bids[i];
      const mirrorOrder = this.createMirrorOrder(level, 'bid', i);
      if (mirrorOrder) {
        mirrorOrders.push(mirrorOrder);
      }
    }

    // Mirror ask orders
    for (let i = 0; i < Math.min(this.config.depthLevels, orderBook.asks.length); i++) {
      const level = orderBook.asks[i];
      const mirrorOrder = this.createMirrorOrder(level, 'ask', i);
      if (mirrorOrder) {
        mirrorOrders.push(mirrorOrder);
      }
    }

    this.logger.debug('Generated mirror orders', {
      count: mirrorOrders.length,
      bids: mirrorOrders.filter((o) => o.side === 'bid').length,
      asks: mirrorOrders.filter((o) => o.side === 'ask').length,
    });

    return mirrorOrders;
  }

  /**
   * Create a single mirror order with randomization
   */
  private createMirrorOrder(
    level: OrderBookLevel,
    side: 'bid' | 'ask',
    levelIndex: number
  ): MirrorOrder | null {
    // Calculate mirrored size
    let size = level.size * this.config.sizeMultiplier;

    // Add randomization to avoid detection
    const randomFactor =
      1 + (Math.random() - 0.5) * (this.config.randomizationPercent / 100);
    size *= randomFactor;

    // Clamp to min/max
    size = Math.max(this.config.minOrderSize, Math.min(size, this.config.maxOrderSize));

    // Add slight price randomization
    const priceRandomization = 1 + (Math.random() - 0.5) * 0.001; // 0.1% randomization
    const price = level.price * priceRandomization;

    return {
      price,
      size,
      side,
      level: levelIndex,
    };
  }

  /**
   * Calculate optimal mirror size based on available liquidity
   */
  calculateMirrorSize(
    availableLiquidity: number,
    targetLevel: number
  ): number {
    // Reduce size for deeper levels
    const depthFactor = 1 / (1 + targetLevel * 0.2);

    // Calculate size
    let size = availableLiquidity * this.config.sizeMultiplier * depthFactor;

    // Add randomization
    const randomFactor =
      1 + (Math.random() - 0.5) * (this.config.randomizationPercent / 100);
    size *= randomFactor;

    // Clamp to limits
    return Math.max(
      this.config.minOrderSize,
      Math.min(size, this.config.maxOrderSize)
    );
  }

  /**
   * Randomize order placement to avoid detection
   */
  randomizeOrders(orders: MirrorOrder[]): MirrorOrder[] {
    return orders.map((order) => {
      // Add small random delay to price
      const priceJitter = (Math.random() - 0.5) * 0.002; // 0.2% jitter
      const sizeJitter = (Math.random() - 0.5) * 0.1; // 10% jitter

      return {
        ...order,
        price: order.price * (1 + priceJitter),
        size: order.size * (1 + sizeJitter),
      };
    });
  }

  /**
   * Check if mirror orders need updating
   */
  shouldUpdateMirrors(): boolean {
    if (!this.lastOrderBook) return true;

    const timeSinceUpdate = Date.now() - this.lastUpdate;
    return timeSinceUpdate >= this.config.updateInterval;
  }

  /**
   * Get current order book snapshot
   */
  getOrderBookSnapshot(): OrderBookDepth | null {
    return this.lastOrderBook;
  }

  /**
   * Fetch order book from Jupiter aggregated liquidity
   */
  private async fetchOrderBookFromDEX(
    baseMint: PublicKey,
    quoteMint: PublicKey
  ): Promise<OrderBookDepth> {
    try {
      // Fetch from Jupiter's quote API to get market depth
      // We'll simulate order book by getting quotes at different amounts
      const amounts = [100, 500, 1000, 5000, 10000]; // Different trade sizes
      const bids: OrderBookLevel[] = [];
      const asks: OrderBookLevel[] = [];

      // Get current mid price first
      const midPriceQuote = await this.fetchJupiterQuote(
        quoteMint,
        baseMint,
        1000000 // 1 USDC worth
      );

      if (!midPriceQuote) {
        return this.getFallbackOrderBook();
      }

      const midPrice = parseFloat(midPriceQuote.outAmount) / parseFloat(midPriceQuote.inAmount);

      // Build bid side (buying base with quote)
      for (let i = 0; i < amounts.length; i++) {
        const amountInQuote = amounts[i] * 1000000; // Convert to lamports
        const quote = await this.fetchJupiterQuote(quoteMint, baseMint, amountInQuote);

        if (quote) {
          const price = parseFloat(quote.inAmount) / parseFloat(quote.outAmount);
          const size = parseFloat(quote.outAmount) / 1e9; // Convert to UI amount

          bids.push({
            price,
            size,
            count: 1, // Jupiter aggregates, so count is conceptual
          });
        }

        // Rate limiting
        await this.sleep(100);
      }

      // Build ask side (selling base for quote)
      for (let i = 0; i < amounts.length; i++) {
        const amountInBase = (amounts[i] / midPrice) * 1e9; // Convert to lamports
        const quote = await this.fetchJupiterQuote(baseMint, quoteMint, amountInBase);

        if (quote) {
          const price = parseFloat(quote.outAmount) / parseFloat(quote.inAmount);
          const size = parseFloat(quote.inAmount) / 1e9; // Convert to UI amount

          asks.push({
            price,
            size,
            count: 1,
          });
        }

        // Rate limiting
        await this.sleep(100);
      }

      // Sort bids descending (highest first)
      bids.sort((a, b) => b.price - a.price);

      // Sort asks ascending (lowest first)
      asks.sort((a, b) => a.price - b.price);

      // Calculate spread
      const bestBid = bids[0]?.price || midPrice * 0.99;
      const bestAsk = asks[0]?.price || midPrice * 1.01;
      const spread = bestAsk - bestBid;

      this.logger.debug('Fetched Jupiter order book', {
        baseMint: baseMint.toString(),
        quoteMint: quoteMint.toString(),
        midPrice: midPrice.toFixed(8),
        spread: spread.toFixed(8),
        bidLevels: bids.length,
        askLevels: asks.length,
      });

      return {
        bids: bids.length > 0 ? bids : this.generateFallbackBids(midPrice),
        asks: asks.length > 0 ? asks : this.generateFallbackAsks(midPrice),
        spread,
        midPrice,
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.warn('Failed to fetch Jupiter order book, using fallback', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return this.getFallbackOrderBook();
    }
  }

  /**
   * Fetch Jupiter quote for a specific amount
   */
  private async fetchJupiterQuote(
    inputMint: PublicKey,
    outputMint: PublicKey,
    amount: number
  ): Promise<{ inAmount: string; outAmount: string; priceImpactPct: string } | null> {
    try {
      const response = await this.rateLimiter.execute(async () => {
        return fetch(
          `https://quote-api.jup.ag/v6/quote?` +
            `inputMint=${inputMint.toString()}&` +
            `outputMint=${outputMint.toString()}&` +
            `amount=${Math.floor(amount)}&` +
            `slippageBps=50`
        );
      });

      if (!response.ok) {
        if (response.status === 429) {
          this.logger.warn('Jupiter rate limit hit in liquidity mirror');
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
        return null;
      }

      const data = (await response.json()) as {
        inAmount?: string;
        outAmount?: string;
        priceImpactPct?: string;
      };

      if (!data.inAmount || !data.outAmount) {
        return null;
      }

      return {
        inAmount: data.inAmount,
        outAmount: data.outAmount,
        priceImpactPct: data.priceImpactPct || '0',
      };
    } catch (error) {
      this.logger.debug('Jupiter quote failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  /**
   * Generate fallback order book when API fails
   */
  private getFallbackOrderBook(): OrderBookDepth {
    const midPrice = 0.0001; // Fallback price
    const spread = midPrice * 0.01; // 1% spread

    return {
      bids: this.generateFallbackBids(midPrice),
      asks: this.generateFallbackAsks(midPrice),
      spread: spread * 2,
      midPrice,
      timestamp: Date.now(),
    };
  }

  /**
   * Generate fallback bid levels
   */
  private generateFallbackBids(midPrice: number): OrderBookLevel[] {
    const spread = midPrice * 0.005; // 0.5% spread
    return [
      { price: midPrice - spread, size: 1000, count: 5 },
      { price: midPrice - spread * 2, size: 2000, count: 8 },
      { price: midPrice - spread * 3, size: 3000, count: 12 },
      { price: midPrice - spread * 4, size: 5000, count: 15 },
      { price: midPrice - spread * 5, size: 8000, count: 20 },
    ];
  }

  /**
   * Generate fallback ask levels
   */
  private generateFallbackAsks(midPrice: number): OrderBookLevel[] {
    const spread = midPrice * 0.005; // 0.5% spread
    return [
      { price: midPrice + spread, size: 1000, count: 5 },
      { price: midPrice + spread * 2, size: 2000, count: 8 },
      { price: midPrice + spread * 3, size: 3000, count: 12 },
      { price: midPrice + spread * 4, size: 5000, count: 15 },
      { price: midPrice + spread * 5, size: 8000, count: 20 },
    ];
  }

  /**
   * Sleep utility for rate limiting
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Calculate total liquidity at each level
   */
  calculateLiquidityDepth(orderBook: OrderBookDepth): {
    bidLiquidity: number[];
    askLiquidity: number[];
  } {
    const bidLiquidity = orderBook.bids.map((level) => level.price * level.size);
    const askLiquidity = orderBook.asks.map((level) => level.price * level.size);

    return { bidLiquidity, askLiquidity };
  }

  /**
   * Detect if order book is imbalanced
   */
  detectImbalance(orderBook: OrderBookDepth): {
    imbalanced: boolean;
    ratio: number;
    side: 'bid' | 'ask' | 'balanced';
  } {
    const { bidLiquidity, askLiquidity } = this.calculateLiquidityDepth(orderBook);

    const totalBidLiquidity = bidLiquidity.reduce((sum, l) => sum + l, 0);
    const totalAskLiquidity = askLiquidity.reduce((sum, l) => sum + l, 0);

    const ratio = totalBidLiquidity / (totalAskLiquidity + totalBidLiquidity);

    // Consider imbalanced if ratio is outside 40-60%
    const imbalanced = ratio < 0.4 || ratio > 0.6;
    const side = ratio < 0.4 ? 'ask' : ratio > 0.6 ? 'bid' : 'balanced';

    return { imbalanced, ratio, side };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<MirrorConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('Liquidity mirror config updated', config);
  }

  /**
   * Get current configuration
   */
  getConfig(): MirrorConfig {
    return { ...this.config };
  }
}
