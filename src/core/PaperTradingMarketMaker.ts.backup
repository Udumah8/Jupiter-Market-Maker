/**
 * Paper Trading Market Maker
 * Wraps MarketMaker to use PaperTradingEngine instead of real trading
 */

import { PublicKey, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import { MarketMaker, MarketMakerConfig } from './MarketMaker.js';
import { PaperTradingEngine, PaperTradingConfig } from '../utils/PaperTradingEngine.js';
import { Logger } from '../utils/Logger.js';
import { RPCManager } from '../utils/RPCManager.js';
import { StateManager } from '../utils/StateManager.js';
import { WalletManager } from '../utils/WalletManager.js';
import { PriceAggregator } from '../pricing/PriceAggregator.js';
import { JupiterSwap } from '../exchange/JupiterSwap.js';
import { JupiterLimitOrders } from '../exchange/JupiterLimitOrders.js';
import { MEVProtection } from '../safety/MEVProtection.js';
import { CircuitBreaker } from '../safety/CircuitBreaker.js';
import { RugPullDetector } from '../safety/RugPullDetector.js';

/**
 * Paper Trading Wrapper for Jupiter Limit Orders
 */
class PaperJupiterLimitOrders {
  constructor(private paperEngine: PaperTradingEngine) { }

  async placeOrder(params: {
    owner: Keypair;
    inputMint: PublicKey;
    outputMint: PublicKey;
    inAmount: BN;
    outAmount: BN;
  }): Promise<any> {
    return await this.paperEngine.placeOrder(params);
  }

  async cancelOrder(wallet: Keypair, orderKey: PublicKey): Promise<void> {
    return await this.paperEngine.cancelOrder(wallet, orderKey);
  }

  async getActiveOrders(wallet: PublicKey): Promise<any[]> {
    return await this.paperEngine.getActiveOrders(wallet);
  }
}

/**
 * Paper Trading Wrapper for Jupiter Swap
 */
class PaperJupiterSwap {
  constructor(_paperEngine: PaperTradingEngine) {
    // Paper engine not used in simplified implementation
  }

  async buyMarketOrder(
    _wallet: Keypair,
    _baseMint: PublicKey,
    _quoteMint: PublicKey,
    _quoteAmount: BN,
    _maxSlippage: number
  ): Promise<string> {
    // Skip rebalancing in paper trading - just return a dummy transaction
    return 'paper-rebalance-skipped';
  }

  async sellMarketOrder(
    _wallet: Keypair,
    _baseMint: PublicKey,
    _quoteMint: PublicKey,
    _baseAmount: BN,
    _maxSlippage: number
  ): Promise<string> {
    // Skip rebalancing in paper trading - just return a dummy transaction
    return 'paper-rebalance-skipped';
  }
}

export class PaperTradingMarketMaker extends MarketMaker {
  private paperEngine: PaperTradingEngine;
  private statsInterval: NodeJS.Timeout | null = null;

  constructor(
    config: MarketMakerConfig,
    rpcManager: RPCManager,
    stateManager: StateManager,
    walletManager: WalletManager,
    priceAggregator: PriceAggregator,
    _jupiterSwap: JupiterSwap,
    _jupiterOrders: JupiterLimitOrders,
    mevProtection: MEVProtection,
    circuitBreaker: CircuitBreaker,
    rugPullDetector: RugPullDetector,
    logger: Logger,
    paperConfig: PaperTradingConfig
  ) {
    // Create paper trading engine
    const paperEngine = new PaperTradingEngine(paperConfig, logger);

    // Wrap Jupiter components with paper trading versions
    const paperJupiterOrders = new PaperJupiterLimitOrders(paperEngine) as any;
    const paperJupiterSwap = new PaperJupiterSwap(paperEngine) as any;

    // Call parent constructor with paper trading wrappers
    super(
      config,
      rpcManager,
      stateManager,
      walletManager,
      priceAggregator,
      paperJupiterSwap,
      paperJupiterOrders,
      mevProtection,
      circuitBreaker,
      rugPullDetector,
      logger
    );

    this.paperEngine = paperEngine;

    // Override the parent's private initializeInventory method to use paper balances
    (this as any).initializeInventory = this.initializeInventoryOverride.bind(this);

    // Override autoBalanceInventory to skip rebalancing in paper trading
    (this as any).autoBalanceInventory = this.skipAutoBalanceInventory.bind(this);

    logger.info('Paper Trading Market Maker initialized', {
      mode: 'PAPER TRADING',
      initialBalances: Array.from(paperConfig.initialBalances.entries())
    });
  }

  private async skipAutoBalanceInventory(): Promise<void> {
    // Skip rebalancing in paper trading mode
    return;
  }

  async initialize(): Promise<void> {
    await super.initialize();

    // Clear volatility window for paper trading to prevent stale data issues
    (this as any).volatilityWindow = [];
    (this as any).logger.info('Paper trading: cleared volatility window to prevent stale data');

    // Initialize paper wallets
    const wallets = (this as any).walletManager.getTradingWallets();
    for (const wallet of wallets) {
      this.paperEngine.initializeWallet(wallet.publicKey);

      const walletKey = wallet.publicKey.toString();
      const baseBalance = this.paperEngine.getBalance(wallet.publicKey, (this as any).config.baseMint);
      const quoteBalance = this.paperEngine.getBalance(wallet.publicKey, (this as any).config.quoteMint);

      (this as any).inventory.set(walletKey, {
        base: baseBalance,
        quote: quoteBalance,
        avgBuyPrice: 0,
        lastUpdate: Date.now(),
      });

      (this as any).logger.info('Paper trading inventory set', {
        wallet: walletKey,
        base: baseBalance.toString(),
        quote: quoteBalance.toString(),
      });
    }

    this.startStatsReporting();
  }

  async start(): Promise<void> {
    (this as any).logger.info('');
    (this as any).logger.info('═══════════════════════════════════════════════════════');
    (this as any).logger.info('📊 PAPER TRADING MODE ACTIVE');
    (this as any).logger.info('═══════════════════════════════════════════════════════');
    (this as any).logger.info('⚠️  NO REAL FUNDS WILL BE USED');
    (this as any).logger.info('⚠️  ALL TRADES ARE SIMULATED');
    (this as any).logger.info('═══════════════════════════════════════════════════════');
    (this as any).logger.info('');

    (this as any).isRunning = true;
    this.startPriceUpdateLoop();
    await super.start();
  }

  private startPriceUpdateLoop(): void {
    // Initial sync
    (async () => {
      try {
        const price = await (this as any).priceAggregator.getPrice(
          (this as any).config.baseMint,
          (this as any).config.quoteMint
        );
        if (price) {
          this.paperEngine.updateMarketPrice(price.midPrice);

          // Initialize avgBuyPrice for all wallets to prevent false max loss triggers
          const wallets = (this as any).walletManager.getTradingWallets();
          for (const wallet of wallets) {
            const walletKey = wallet.publicKey.toString();
            const inventory = (this as any).inventory.get(walletKey);
            if (inventory && inventory.avgBuyPrice === 0) {
              inventory.avgBuyPrice = price.midPrice;
            }
          }

          (this as any).logger.info('Paper trading price synced', { price: price.midPrice });
        }
      } catch (error) {
        // Ignore initial sync error
      }
    })();

    setInterval(async () => {
      try {
        const price = await (this as any).priceAggregator.getPrice(
          (this as any).config.baseMint,
          (this as any).config.quoteMint
        );
        if (price) {
          this.paperEngine.updateMarketPrice(price.midPrice);
        }
      } catch (error) {
        // Silently fail
      }

      this.syncInventoryFromPaperEngine();
    }, 1000);
  }

  async stop(): Promise<void> {
    await super.stop();
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }
    this.printFinalStats();
  }

  updateMarketPrice(price: number): void {
    this.paperEngine.updateMarketPrice(price);
  }

  private async initializeInventoryOverride(wallet: Keypair): Promise<void> {
    const walletKey = wallet.publicKey.toString();
    const baseBalance = this.paperEngine.getBalance(wallet.publicKey, (this as any).config.baseMint);
    const quoteBalance = this.paperEngine.getBalance(wallet.publicKey, (this as any).config.quoteMint);

    (this as any).inventory.set(walletKey, {
      base: baseBalance,
      quote: quoteBalance,
      avgBuyPrice: 0,
      lastUpdate: Date.now(),
    });

    (this as any).orderStates.set(walletKey, {
      bid: null,
      ask: null,
      walls: { bidWall: null, askWall: null },
      lastRefresh: Date.now(),
    });

    (this as any).logger.info('Initialized paper trading inventory', {
      wallet: walletKey,
      base: baseBalance.toString(),
      quote: quoteBalance.toString(),
    });
  }

  private syncInventoryFromPaperEngine(): void {
    const wallets = (this as any).walletManager.getTradingWallets();
    for (const wallet of wallets) {
      const walletKey = wallet.publicKey.toString();
      const baseBalance = this.paperEngine.getBalance(wallet.publicKey, (this as any).config.baseMint);
      const quoteBalance = this.paperEngine.getBalance(wallet.publicKey, (this as any).config.quoteMint);

      const currentInventory = (this as any).inventory.get(walletKey);
      if (currentInventory) {
        currentInventory.base = baseBalance;
        currentInventory.quote = quoteBalance;
        currentInventory.lastUpdate = Date.now();
      }
    }
  }

  getStats() {
    return this.paperEngine.getStats();
  }

  exportHistory() {
    return this.paperEngine.exportHistory();
  }

  resetPaperTrading(): void {
    this.paperEngine.reset();
    (this as any).logger.info('Paper trading state reset');
  }

  private startStatsReporting(): void {
    this.statsInterval = setInterval(() => {
      const stats = this.paperEngine.getStats();

      (this as any).logger.info('');
      (this as any).logger.info('═══════════════════════════════════════════════════════');
      (this as any).logger.info('📊 PAPER TRADING STATS');
      (this as any).logger.info('═══════════════════════════════════════════════════════');
      (this as any).logger.info(`Total Trades: ${stats.totalTrades}`);
      (this as any).logger.info(`Total Volume: ${stats.totalVolume.toFixed(2)}`);
      (this as any).logger.info(`Total Profit: ${stats.totalProfit.toFixed(2)}`);
      (this as any).logger.info(`Total Loss: ${stats.totalLoss.toFixed(2)}`);
      (this as any).logger.info(`Win Rate: ${(stats.winRate * 100).toFixed(2)}%`);
      (this as any).logger.info(`Avg Profit: ${stats.avgProfit.toFixed(2)}`);
      (this as any).logger.info(`Avg Loss: ${stats.avgLoss.toFixed(2)}`);
      (this as any).logger.info(`Sharpe Ratio: ${stats.sharpeRatio.toFixed(2)}`);
      (this as any).logger.info(`Max Drawdown: ${stats.maxDrawdown.toFixed(2)}%`);
      (this as any).logger.info(`ROI: ${stats.roi.toFixed(2)}%`);
      (this as any).logger.info(`Current Balance: ${stats.currentBalance.toFixed(2)}`);
      (this as any).logger.info('═══════════════════════════════════════════════════════');
      (this as any).logger.info('');
    }, 60000);
  }

  private printFinalStats(): void {
    const stats = this.paperEngine.getStats();
    const history = this.paperEngine.exportHistory();

    (this as any).logger.info('');
    (this as any).logger.info('═══════════════════════════════════════════════════════');
    (this as any).logger.info('📊 FINAL PAPER TRADING RESULTS');
    (this as any).logger.info('═══════════════════════════════════════════════════════');
    (this as any).logger.info(`Duration: ${(history.duration / 1000 / 60).toFixed(2)} minutes`);
    (this as any).logger.info(`Total Trades: ${stats.totalTrades}`);
    (this as any).logger.info(`Total Volume: ${stats.totalVolume.toFixed(2)}`);
    (this as any).logger.info(`Net Profit/Loss: ${(stats.totalProfit - stats.totalLoss).toFixed(2)}`);
    (this as any).logger.info(`Win Rate: ${(stats.winRate * 100).toFixed(2)}%`);
    (this as any).logger.info(`Sharpe Ratio: ${stats.sharpeRatio.toFixed(2)}`);
    (this as any).logger.info(`Max Drawdown: ${stats.maxDrawdown.toFixed(2)}%`);
    (this as any).logger.info(`ROI: ${stats.roi.toFixed(2)}%`);
    (this as any).logger.info(`Starting Balance: ${stats.startingBalance.toFixed(2)}`);
    (this as any).logger.info(`Final Balance: ${stats.currentBalance.toFixed(2)}`);
    (this as any).logger.info('═══════════════════════════════════════════════════════');
    (this as any).logger.info('');
  }
}