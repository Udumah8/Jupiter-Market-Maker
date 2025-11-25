/**
 * Enhanced Wallet Manager - Supports 10,000+ Wallets
 * Integrates WalletGenerator, EncryptionManager, FundingManager, and WithdrawalManager
 */

import { Keypair, Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import { Logger } from './Logger.js';
import { WalletGenerator } from './WalletGenerator.js';
import { EncryptionManager, EncryptedWallet } from './EncryptionManager.js';
import { FundingManager } from './FundingManager.js';
import { WithdrawalManagerV2 } from './WithdrawalManager.js';
import BN from 'bn.js';

export interface WalletManagerConfig {
  masterSeed?: string;
  encryptionKey: string;
  numberOfWallets: number;
  walletsFilePath: string;
  autoFundThresholdSol: number;
  fundingAmountSol: number;
  autoWithdrawThresholdSol: number;
  minBalanceToKeepSol: number;
}

export class WalletManager {
  private masterWallet: Keypair | null = null;
  private tradingWallets: Keypair[] = [];
  private walletGenerator: WalletGenerator | null = null;
  private encryptionManager: EncryptionManager;
  private fundingManager: FundingManager | null = null;
  private withdrawalManager: WithdrawalManagerV2 | null = null;
  private logger: Logger;
  private config: WalletManagerConfig;
  private walletsLoaded: boolean = false;

  constructor(
    config: WalletManagerConfig,
    connection: Connection,
    logger: Logger
  ) {
    this.config = config;
    this.logger = logger;
    this.encryptionManager = new EncryptionManager(config.encryptionKey, logger);

    // Initialize funding and withdrawal managers
    this.fundingManager = new FundingManager(
      connection,
      {
        autoFundThresholdSol: config.autoFundThresholdSol,
        fundingAmountSol: config.fundingAmountSol,
        batchSize: 10,
        maxRetries: 3,
      },
      logger
    );

    this.withdrawalManager = new WithdrawalManagerV2(
      connection,
      {
        autoWithdrawThresholdSol: config.autoWithdrawThresholdSol,
        minBalanceToKeepSol: config.minBalanceToKeepSol,
        batchSize: 10,
        concurrency: 4,
        maxRetries: 3,
        closeTokenAccounts: false,
      },
      logger
    );
  }

  /**
   * Initialize wallet manager - load or generate wallets
   */
  async initialize(masterWalletPrivateKey: string): Promise<void> {
    this.logger.info('Initializing Wallet Manager...');

    // Load master wallet
    this.masterWallet = this.keypairFromPrivateKey(masterWalletPrivateKey);
    this.logger.info('Master wallet loaded', {
      publicKey: this.masterWallet.publicKey.toString(),
    });

    // Check if wallets file exists
    if (fs.existsSync(this.config.walletsFilePath)) {
      await this.loadWalletsFromFile();
    } else {
      await this.generateAndSaveWallets();
    }

    this.walletsLoaded = true;
    this.logger.info('Wallet Manager initialized', {
      tradingWallets: this.tradingWallets.length,
    });
  }

  /**
   * Generate new wallets from master seed
   */
  async generateAndSaveWallets(): Promise<void> {
    this.logger.info('Generating new wallets', {
      count: this.config.numberOfWallets,
    });

    if (!this.config.masterSeed) {
      throw new Error('Master seed required for wallet generation');
    }

    // Initialize wallet generator
    this.walletGenerator = new WalletGenerator(this.config.masterSeed, this.logger);

    // Generate wallets
    const generatedWallets = await this.walletGenerator.generateWalletsBatch(
      this.config.numberOfWallets,
      0,
      1000 // Batch size
    );

    // Encrypt wallets
    const encryptedWallets = this.encryptionManager.encryptWalletsBatch(
      generatedWallets.map((w) => ({
        keypair: w.keypair,
        index: w.index,
        derivationPath: w.derivationPath,
      }))
    );

    // Save to file
    await this.saveWalletsToFile(encryptedWallets);

    // Load into memory
    this.tradingWallets = generatedWallets.map((w) => w.keypair);

    this.logger.info('Wallets generated and saved', {
      count: this.tradingWallets.length,
      filePath: this.config.walletsFilePath,
    });
  }

  /**
   * Load wallets from encrypted file
   */
  async loadWalletsFromFile(): Promise<void> {
    this.logger.info('Loading wallets from file', {
      filePath: this.config.walletsFilePath,
    });

    try {
      const fileContent = fs.readFileSync(this.config.walletsFilePath, 'utf8');
      const encryptedWallets = this.encryptionManager.importFromJSON(fileContent);

      // Decrypt wallets
      this.tradingWallets = this.encryptionManager.decryptWalletsBatch(
        encryptedWallets
      );

      this.logger.info('Wallets loaded from file', {
        count: this.tradingWallets.length,
      });
    } catch (error) {
      this.logger.error('Failed to load wallets from file', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Save encrypted wallets to file
   */
  async saveWalletsToFile(encryptedWallets: EncryptedWallet[]): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.config.walletsFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const json = this.encryptionManager.exportToJSON(encryptedWallets);
      fs.writeFileSync(this.config.walletsFilePath, json, 'utf8');

      this.logger.info('Wallets saved to file', {
        count: encryptedWallets.length,
        filePath: this.config.walletsFilePath,
      });
    } catch (error) {
      this.logger.error('Failed to save wallets to file', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Auto-fund wallets below threshold
   */
  async autoFundWallets(tokenMint?: PublicKey): Promise<void> {
    if (!this.masterWallet || !this.fundingManager) {
      throw new Error('Wallet Manager not initialized');
    }

    this.logger.info('Starting auto-funding check...');

    await this.fundingManager.autoFundWallets(
      this.masterWallet,
      this.tradingWallets,
      tokenMint
    );
  }

  /**
   * Auto-withdraw profits from wallets
   */
  async autoWithdrawProfits(tokenMint?: PublicKey): Promise<void> {
    if (!this.masterWallet || !this.withdrawalManager) {
      throw new Error('Wallet Manager not initialized');
    }

    this.logger.info('Starting auto-withdrawal check...');

    await this.withdrawalManager.autoWithdrawProfits(
      this.tradingWallets,
      this.masterWallet,
      tokenMint
    );
  }

  /**
   * Emergency withdrawal - collect all funds
   */
  async emergencyWithdraw(tokenMint?: PublicKey): Promise<void> {
    if (!this.masterWallet || !this.withdrawalManager) {
      throw new Error('Wallet Manager not initialized');
    }

    this.logger.warn('EMERGENCY WITHDRAWAL INITIATED');

    await this.withdrawalManager.emergencyWithdraw(
      this.tradingWallets,
      this.masterWallet,
      tokenMint
    );
  }

  /**
   * Get master wallet
   */
  getMasterWallet(): Keypair {
    if (!this.masterWallet) {
      throw new Error('Master wallet not loaded');
    }
    return this.masterWallet;
  }

  /**
   * Get all trading wallets
   */
  getTradingWallets(): Keypair[] {
    if (!this.walletsLoaded) {
      throw new Error('Wallets not loaded. Call initialize() first.');
    }
    return this.tradingWallets;
  }

  /**
   * Get specific wallet by index
   */
  getWallet(index: number): Keypair {
    if (index < 0 || index >= this.tradingWallets.length) {
      throw new Error(`Wallet index ${index} out of range`);
    }
    return this.tradingWallets[index];
  }

  /**
   * Get wallet count
   */
  getWalletCount(): number {
    return this.tradingWallets.length;
  }

  /**
   * Add more wallets (expand wallet pool)
   */
  async addWallets(count: number): Promise<void> {
    if (!this.config.masterSeed) {
      throw new Error('Master seed required to add wallets');
    }

    this.logger.info('Adding more wallets', { count });

    const currentCount = this.tradingWallets.length;

    // Initialize generator if not already done
    if (!this.walletGenerator) {
      this.walletGenerator = new WalletGenerator(this.config.masterSeed, this.logger);
    }

    // Generate new wallets starting from current count
    const newWallets = await this.walletGenerator.generateWalletsBatch(
      count,
      currentCount,
      1000
    );

    // Encrypt new wallets
    const encryptedNew = this.encryptionManager.encryptWalletsBatch(
      newWallets.map((w) => ({
        keypair: w.keypair,
        index: w.index,
        derivationPath: w.derivationPath,
      }))
    );

    // Load existing encrypted wallets
    const fileContent = fs.readFileSync(this.config.walletsFilePath, 'utf8');
    const existingEncrypted = this.encryptionManager.importFromJSON(fileContent);

    // Combine and save
    const allEncrypted = [...existingEncrypted, ...encryptedNew];
    await this.saveWalletsToFile(allEncrypted);

    // Add to memory
    this.tradingWallets.push(...newWallets.map((w) => w.keypair));

    this.logger.info('Wallets added', {
      newCount: count,
      totalCount: this.tradingWallets.length,
    });
  }

  /**
   * Get wallet balances
   */
  async getWalletBalances(tokenMint?: PublicKey): Promise<Map<string, { sol: BN; token: BN }>> {
    if (!this.fundingManager) {
      throw new Error('Funding manager not initialized');
    }

    const balances = await this.fundingManager.checkBalances(
      this.tradingWallets,
      tokenMint
    );

    const balanceMap = new Map<string, { sol: BN; token: BN }>();

    for (const balance of balances) {
      balanceMap.set(balance.publicKey.toString(), {
        sol: balance.solBalance,
        token: balance.tokenBalance,
      });
    }

    return balanceMap;
  }

  /**
   * Legacy method for backward compatibility
   */
  public loadWallets(): void {
    this.logger.warn('loadWallets() is deprecated. Use initialize() instead.');
  }

  /**
   * Legacy method for backward compatibility
   */
  public getFundingWallet(): Keypair {
    return this.getMasterWallet();
  }

  /**
   * Convert private key to keypair
   */
  private keypairFromPrivateKey(privateKey: string): Keypair {
    try {
      return Keypair.fromSecretKey(bs58.decode(privateKey));
    } catch (e: unknown) {
      throw new Error(
        `Failed to decode private key: ${e instanceof Error ? e.message : 'Unknown error'}`
      );
    }
  }
}
