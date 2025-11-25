/**
 * Paper Trading Engine
 * Simulates trading without real funds for testing strategies
 */

import { PublicKey, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import { Logger } from './Logger.js';
import { BNMath } from './BNMath.js';

export interface PaperOrder {
  orderId: string;
  orderKey: PublicKey;
  wallet: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inAmount: BN;
  outAmount: BN;
  price: number;
  side: 'buy' | 'sell';
  status: 'active' | 'filled' | 'cancelled';
  createdAt: number;
  filledAt?: number;
  cancelledAt?: number;
}

export interface PaperBalance {
  mint: PublicKey;
  amount: BN;
  decimals: number;
}

export interface PaperTradingStats {
  totalTrades: number;
  totalVolume: number;
  totalProfit: number;
  totalLoss: number;
  winRate: number;
  avgProfit: number;
  avgLoss: number;
  sharpeRatio: number;
  maxDrawdown: number;
  startingBalance: number;
  currentBalance: number;
  roi: number;
}

export interface PaperTradingConfig {
  initialBalances: Map<string, { amount: number; decimals: number }>;
  fillProbability: number; // 0-1, probability of order being filled
  fillDelayMs: number; // Simulated fill delay
  slippagePercent: number; // Simulated slippage
  enableRealisticFills: boolean; // Use market price to determine fills
  feePercent: number; // Trading fee simulation
}

export class PaperTradingEngine {
  private balances: Map<string, Map<string, PaperBalance>> = new Map(); // wallet -> mint -> balance
  private orders: Map<string, PaperOrder> = new Map(); // orderId -> order
  private orderHistory: PaperOrder[] = [];
  private tradeHistory: Array<{
    orderId: string;
    wallet: string;
    side: 'buy' | 'sell';
    price: number;
    amount: number;
    profit: number;
    timestamp: number;
  }> = [];

  private currentMarketPrice: number = 0;
  private priceHistory: number[] = [];
  private startTime: number = Date.now();

  constructor(
    private config: PaperTradingConfig,
    private logger: Logger
  ) {
    this.logger.info('Paper Trading Engine initialized', {
      fillProbability: config.fillProbability,
      fillDelayMs: config.fillDelayMs,
      slippagePercent: config.slippagePercent,
      feePercent: config.feePercent,
    });
  }

  /**
   * Initialize wallet with starting balances
   */
  initializeWallet(wallet: PublicKey, balances?: Map<string, { amount: number; decimals: number }>): void {
    const walletKey = wallet.toString();
    const walletBalances = new Map<string, PaperBalance>();

    const initialBalances = balances || this.config.initialBalances;

    for (const [mintStr, { amount, decimals }] of initialBalances.entries()) {
      const mint = new PublicKey(mintStr);
      walletBalances.set(mintStr, {
        mint,
        amount: BNMath.toTokenAmount(amount, decimals),
        decimals,
      });
    }

    this.balances.set(walletKey, walletBalances);

    this.logger.info('Paper wallet initialized', {
      wallet: walletKey,
      balances: Array.from(initialBalances.entries()).map(([mint, { amount }]) => ({
        mint,
        amount,
      })),
    });
  }

  /**
   * Place a paper order
   */
  async placeOrder(params: {
    owner: Keypair;
    inputMint: PublicKey;
    outputMint: PublicKey;
    inAmount: BN;
    outAmount: BN;
  }): Promise<PaperOrder> {
    const walletKey = params.owner.publicKey.toString();
    const inputMintStr = params.inputMint.toString();
    const outputMintStr = params.outputMint.toString();

    // Check balance
    const walletBalances = this.balances.get(walletKey);
    if (!walletBalances) {
      throw new Error(`Wallet not initialized: ${walletKey}`);
    }

    const inputBalance = walletBalances.get(inputMintStr);
    if (!inputBalance || inputBalance.amount.lt(params.inAmount)) {
      throw new Error(`Insufficient balance for ${inputMintStr}`);
    }

    // Determine side
    const side = this.determineSide(params.inputMint, params.outputMint);

    // Calculate price (Always Quote / Base)
    let price: number;
    if (side === 'buy') {
      // Buy: Input = Quote, Output = Base
      // Price = Input / Output
      price = BNMath.calculatePrice(
        params.inAmount,
        params.outAmount,
        inputBalance.decimals,
        walletBalances.get(outputMintStr)?.decimals || 6
      );
    } else {
      // Sell: Input = Base, Output = Quote
      // Price = Output / Input
      price = BNMath.calculatePrice(
        params.outAmount,
        params.inAmount,
        walletBalances.get(outputMintStr)?.decimals || 6,
        inputBalance.decimals
      );
    }

    // Create order
    const orderId = this.generateOrderId();
    const order: PaperOrder = {
      orderId,
      orderKey: new PublicKey(orderId), // Use orderId as fake public key
      wallet: params.owner.publicKey,
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmount: params.inAmount,
      outAmount: params.outAmount,
      price,
      side,
      status: 'active',
      createdAt: Date.now(),
    };

    this.orders.set(orderId, order);

    this.logger.info('Paper order placed', {
      orderId,
      wallet: walletKey,
      side,
      price: price.toFixed(6),
      inAmount: params.inAmount.toString(),
      outAmount: params.outAmount.toString(),
    });

    // Simulate fill with delay
    if (this.config.enableRealisticFills) {
      this.scheduleRealisticFill(order);
    } else {
      this.scheduleRandomFill(order);
    }

    return order;
  }

  /**
   * Cancel a paper order
   */
  async cancelOrder(wallet: Keypair, orderKey: PublicKey): Promise<void> {
    const orderId = orderKey.toString();
    const order = this.orders.get(orderId);

    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (order.status !== 'active') {
      throw new Error(`Order not active: ${orderId}`);
    }

    order.status = 'cancelled';
    order.cancelledAt = Date.now();
    this.orders.delete(orderId);
    this.orderHistory.push(order);

    this.logger.info('Paper order cancelled', {
      orderId,
      wallet: wallet.publicKey.toString(),
    });
  }

  /**
   * Get active orders for a wallet
   */
  async getActiveOrders(wallet: PublicKey): Promise<PaperOrder[]> {
    const walletKey = wallet.toString();
    return Array.from(this.orders.values()).filter(
      order => order.wallet.toString() === walletKey && order.status === 'active'
    );
  }

  /**
   * Get balance for a wallet and mint
   */
  getBalance(wallet: PublicKey, mint: PublicKey): BN {
    const walletKey = wallet.toString();
    const mintStr = mint.toString();
    const walletBalances = this.balances.get(walletKey);

    if (!walletBalances) {
      return new BN(0);
    }

    const balance = walletBalances.get(mintStr);
    return balance ? balance.amount : new BN(0);
  }

  /**
   * Update market price (for realistic fills)
   */
  updateMarketPrice(price: number): void {
    this.currentMarketPrice = price;
    this.priceHistory.push(price);

    // Keep last 100 prices
    if (this.priceHistory.length > 100) {
      this.priceHistory.shift();
    }
  }

  /**
   * Get trading statistics
   */
  getStats(): PaperTradingStats {
    const totalTrades = this.tradeHistory.length;
    const totalProfit = this.tradeHistory
      .filter(t => t.profit > 0)
      .reduce((sum, t) => sum + t.profit, 0);
    const totalLoss = Math.abs(
      this.tradeHistory
        .filter(t => t.profit < 0)
        .reduce((sum, t) => sum + t.profit, 0)
    );

    const winningTrades = this.tradeHistory.filter(t => t.profit > 0).length;
    const losingTrades = this.tradeHistory.filter(t => t.profit < 0).length;
    const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;

    const avgProfit = winningTrades > 0 ? totalProfit / winningTrades : 0;
    const avgLoss = losingTrades > 0 ? totalLoss / losingTrades : 0;

    // Calculate Sharpe ratio (simplified)
    const returns = this.calculateReturns();
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const stdDev = this.calculateStdDev(returns, avgReturn);
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

    // Calculate max drawdown
    const maxDrawdown = this.calculateMaxDrawdown();

    // Calculate current balance (sum of all balances in quote terms)
    const currentBalance = this.calculateTotalBalance();

    // Find starting balance (Quote mint)
    // We assume the second entry is quote, but let's try to be smarter
    // We'll use the quote mint from the first wallet's balances if available
    let startingBalance = 0;
    const firstWallet = this.balances.values().next().value;
    if (firstWallet) {
      // Try to find the quote mint by looking for the one with larger amount (heuristic)
      // Or just default to the second one as before but with a fallback
      const mints = Array.from(this.config.initialBalances.keys());
      if (mints.length >= 2) {
        startingBalance = this.config.initialBalances.get(mints[1])?.amount || 0;
      } else if (mints.length === 1) {
        startingBalance = this.config.initialBalances.get(mints[0])?.amount || 0;
      }
    }

    // Calculate ROI, handling edge cases to prevent NaN
    let roi = 0;
    if (startingBalance > 0 && currentBalance !== startingBalance) {
      roi = ((currentBalance - startingBalance) / startingBalance) * 100;
    } else if (startingBalance === 0 && currentBalance > 0) {
      // If we started with 0 and now have balance, that's infinite ROI, cap at 100%
      roi = 100;
    }
    // If startingBalance === currentBalance, ROI remains 0 (no change yet)

    // Final validation - ensure currentBalance and ROI are valid numbers
    const validCurrentBalance = (isNaN(currentBalance) || !isFinite(currentBalance)) ? startingBalance : currentBalance;
    const validROI = (isNaN(roi) || !isFinite(roi)) ? 0 : roi;

    return {
      totalTrades,
      totalVolume: this.tradeHistory.reduce((sum, t) => sum + t.amount * t.price, 0),
      totalProfit,
      totalLoss,
      winRate,
      avgProfit,
      avgLoss,
      sharpeRatio,
      maxDrawdown,
      startingBalance,
      currentBalance: validCurrentBalance,
      roi: validROI,
    };
  }

  /**
   * Reset paper trading state
   */
  reset(): void {
    this.orders.clear();
    this.orderHistory = [];
    this.tradeHistory = [];
    this.priceHistory = [];
    this.startTime = Date.now();

    this.logger.info('Paper trading state reset');
  }

  /**
   * Export trading history
   */
  exportHistory(): any {
    return {
      orders: this.orderHistory,
      trades: this.tradeHistory,
      stats: this.getStats(),
      duration: Date.now() - this.startTime,
    };
  }

  // Private methods

  private determineSide(_inputMint: PublicKey, outputMint: PublicKey): 'buy' | 'sell' {
    // Assume first mint in config is base, second is quote
    const baseMint = Array.from(this.config.initialBalances.keys())[0];
    return outputMint.toString() === baseMint ? 'buy' : 'sell';
  }

  private generateOrderId(): string {
    // Generate a valid Solana PublicKey by creating random 32 bytes
    const randomBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      randomBytes[i] = Math.floor(Math.random() * 256);
    }
    // Create a PublicKey from the random bytes and return its base58 string
    return new PublicKey(randomBytes).toBase58();
  }

  private scheduleRandomFill(order: PaperOrder): void {
    setTimeout(() => {
      if (order.status !== 'active') {
        this.logger.debug('Order no longer active, skipping fill', { orderId: order.orderId, status: order.status });
        return;
      }

      // Random fill based on probability
      const random = Math.random();
      if (random < this.config.fillProbability) {
        this.logger.debug('Filling order based on probability', { orderId: order.orderId, random, threshold: this.config.fillProbability });
        this.fillOrder(order);
      } else {
        this.logger.debug('Order not filled due to probability', { orderId: order.orderId, random, threshold: this.config.fillProbability });
      }
    }, this.config.fillDelayMs);
  }

  private scheduleRealisticFill(order: PaperOrder): void {
    const checkInterval = setInterval(() => {
      if (order.status !== 'active') {
        clearInterval(checkInterval);
        return;
      }

      // Check if market price crosses order price
      if (this.shouldFillOrder(order)) {
        this.fillOrder(order);
        clearInterval(checkInterval);
      }
    }, 1000); // Check every second

    // Auto-cancel after 5 minutes if not filled
    setTimeout(() => {
      if (order.status === 'active') {
        clearInterval(checkInterval);
        order.status = 'cancelled';
        order.cancelledAt = Date.now();
        this.orders.delete(order.orderId);
        this.orderHistory.push(order);
      }
    }, 300000);
  }

  private shouldFillOrder(order: PaperOrder): boolean {
    if (this.currentMarketPrice === 0) return false;

    // Buy order fills when market price <= order price
    // Sell order fills when market price >= order price
    if (order.side === 'buy') {
      return this.currentMarketPrice <= order.price * (1 + this.config.slippagePercent / 100);
    } else {
      return this.currentMarketPrice >= order.price * (1 - this.config.slippagePercent / 100);
    }
  }

  private fillOrder(order: PaperOrder): void {
    const walletKey = order.wallet.toString();
    const walletBalances = this.balances.get(walletKey);

    if (!walletBalances) {
      this.logger.error('Wallet not found for fill', { wallet: walletKey, orderId: order.orderId });
      return;
    }

    const inputMintStr = order.inputMint.toString();
    const outputMintStr = order.outputMint.toString();

    const inputBalance = walletBalances.get(inputMintStr);
    const outputBalance = walletBalances.get(outputMintStr);

    if (!inputBalance) {
      this.logger.error('Input balance not found for fill', {
        inputMint: inputMintStr,
        orderId: order.orderId,
        availableMints: Array.from(walletBalances.keys())
      });
      return;
    }

    if (!outputBalance) {
      this.logger.error('Output balance not found for fill', {
        outputMint: outputMintStr,
        orderId: order.orderId,
        availableMints: Array.from(walletBalances.keys())
      });
      return;
    }

    // Check if we have enough balance
    if (inputBalance.amount.lt(order.inAmount)) {
      this.logger.error('Insufficient balance for fill', {
        orderId: order.orderId,
        required: order.inAmount.toString(),
        available: inputBalance.amount.toString(),
        inputMint: inputMintStr
      });
      return;
    }

    // Apply slippage and fees
    const slippageFactor = 1 - this.config.slippagePercent / 100;
    const feeFactor = 1 - this.config.feePercent / 100;
    const adjustedOutAmount = order.outAmount.muln(slippageFactor * feeFactor * 10000).divn(10000);

    // Update balances
    inputBalance.amount = inputBalance.amount.sub(order.inAmount);
    outputBalance.amount = outputBalance.amount.add(adjustedOutAmount);

    // Update order status
    order.status = 'filled';
    order.filledAt = Date.now();
    this.orders.delete(order.orderId);
    this.orderHistory.push(order);

    // Calculate profit based on fees and slippage (simplified for paper trading)
    // In paper trading, profit comes from the spread between buy and sell
    // If currentMarketPrice is 0 (not yet available), use order.price to avoid massive PnL swings
    const fillPrice = this.currentMarketPrice || order.price;

    // Calculate trade value in USD terms (quote currency)
    // For buy orders: inAmount is quote (USD), for sell orders: outAmount is quote (USD)
    const tradeValueUSD = order.side === 'buy'
      ? BNMath.toUIAmountNumber(order.inAmount, inputBalance.decimals)
      : BNMath.toUIAmountNumber(order.outAmount, outputBalance.decimals);

    // Profit is the difference between what we paid in fees/slippage vs what we would have paid
    // This is a simplified model - in reality profit comes from spread capture
    const feesCost = tradeValueUSD * (this.config.feePercent / 100);
    const slippageCost = tradeValueUSD * (this.config.slippagePercent / 100);

    // For paper trading, assume we capture half the spread as profit (0.5%)
    const profit = tradeValueUSD * 0.005 - feesCost - slippageCost;

    // Record trade
    this.tradeHistory.push({
      orderId: order.orderId,
      wallet: walletKey,
      side: order.side,
      price: fillPrice,
      amount: tradeValueUSD, // Use USD value for consistent tracking
      profit,
      timestamp: Date.now(),
    });

    this.logger.info('Paper order filled', {
      orderId: order.orderId,
      wallet: walletKey,
      side: order.side,
      price: fillPrice.toFixed(6),
      profit: profit.toFixed(6),
      slippage: this.config.slippagePercent,
      fee: this.config.feePercent,
    });
  }

  private calculateReturns(): number[] {
    const returns: number[] = [];
    for (let i = 1; i < this.tradeHistory.length; i++) {
      const prevTrade = this.tradeHistory[i - 1];
      const currTrade = this.tradeHistory[i];
      const ret = (currTrade.profit - prevTrade.profit) / Math.abs(prevTrade.profit || 1);
      returns.push(ret);
    }
    return returns;
  }

  private calculateStdDev(values: number[], mean: number): number {
    if (values.length === 0) return 0;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
  }

  private calculateMaxDrawdown(): number {
    let maxDrawdown = 0;
    let peak = 0;
    let cumProfit = 0;

    for (const trade of this.tradeHistory) {
      cumProfit += trade.profit;
      if (cumProfit > peak) {
        peak = cumProfit;
      }
      const drawdown = (peak - cumProfit) / (peak || 1);
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return maxDrawdown * 100;
  }

  private calculateTotalBalance(): number {
    // If we don't have a market price yet, return the starting balance to avoid NaN
    if (this.currentMarketPrice === 0) {
      const quoteMint = Array.from(this.config.initialBalances.keys())[1] || '';
      return this.config.initialBalances.get(quoteMint)?.amount || 0;
    }

    let total = 0;
    const quoteMint = Array.from(this.config.initialBalances.keys())[1] || '';

    for (const [, walletBalances] of this.balances) {
      for (const [mintStr, balance] of walletBalances) {
        if (mintStr === quoteMint) {
          const quoteAmount = BNMath.toUIAmountNumber(balance.amount, balance.decimals);
          // Validate the amount is a valid number
          if (!isNaN(quoteAmount) && isFinite(quoteAmount)) {
            total += quoteAmount;
          }
        } else {
          // Convert to quote terms using current market price
          const amount = BNMath.toUIAmountNumber(balance.amount, balance.decimals);
          // Validate both amount and price are valid numbers
          if (!isNaN(amount) && isFinite(amount) && !isNaN(this.currentMarketPrice) && isFinite(this.currentMarketPrice)) {
            total += amount * this.currentMarketPrice;
          }
        }
      }
    }

    // Final validation - if total is still NaN or not finite, return starting balance
    if (isNaN(total) || !isFinite(total)) {
      const quoteMint = Array.from(this.config.initialBalances.keys())[1] || '';
      return this.config.initialBalances.get(quoteMint)?.amount || 0;
    }

    return total;
  }
}
