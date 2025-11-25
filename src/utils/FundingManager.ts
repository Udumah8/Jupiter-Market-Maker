/**
 * Funding Manager - Auto-funding and Distribution
 * Handles SOL and token distribution to trading wallets
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
} from '@solana/spl-token';
import BN from 'bn.js';
import { Logger } from './Logger.js';
import pRetry from 'p-retry';

export interface FundingConfig {
  autoFundThresholdSol: number;
  fundingAmountSol: number;
  autoFundThresholdToken?: BN;
  fundingAmountToken?: BN;
  batchSize: number;
  maxRetries: number;
  dynamicBufferEnabled?: boolean; // Enable dynamic buffer based on priority fees
  minBufferSol?: number; // Minimum buffer (default 0.05 SOL)
  maxBufferSol?: number; // Maximum buffer (default 0.2 SOL)
}

export interface WalletBalance {
  publicKey: PublicKey;
  solBalance: BN;
  tokenBalance: BN;
  needsFunding: boolean;
}

export class FundingManager {
  private connection: Connection;
  private logger: Logger;
  private config: FundingConfig;
  private recentPriorityFees: number[] = []; // Track recent priority fees for dynamic buffer

  constructor(connection: Connection, config: FundingConfig, logger: Logger) {
    this.connection = connection;
    this.config = {
      ...config,
      dynamicBufferEnabled: config.dynamicBufferEnabled ?? true,
      minBufferSol: config.minBufferSol ?? 0.05,
      maxBufferSol: config.maxBufferSol ?? 0.2,
    };
    this.logger = logger;
  }

  /**
   * Calculate dynamic buffer based on recent priority fees
   */
  private async calculateDynamicBuffer(): Promise<number> {
    if (!this.config.dynamicBufferEnabled) {
      return this.config.minBufferSol!;
    }

    try {
      // Get recent priority fees from the network
      const recentFees = await this.connection.getRecentPrioritizationFees();
      
      if (recentFees.length === 0) {
        return this.config.minBufferSol!;
      }

      // Calculate average priority fee
      const avgPriorityFee = recentFees.reduce((sum, fee) => sum + fee.prioritizationFee, 0) / recentFees.length;
      
      // Store for tracking
      this.recentPriorityFees.push(avgPriorityFee);
      if (this.recentPriorityFees.length > 20) {
        this.recentPriorityFees.shift();
      }

      // Calculate buffer based on fee level
      // Base: 0.05 SOL for normal fees (< 10k microlamports)
      // Scale up to 0.2 SOL for high fees (> 100k microlamports)
      const feeMultiplier = Math.min(avgPriorityFee / 10000, 10); // Cap at 10x
      const buffer = Math.min(
        Math.max(
          this.config.minBufferSol! * (1 + feeMultiplier * 0.3),
          this.config.minBufferSol!
        ),
        this.config.maxBufferSol!
      );

      this.logger.debug('Dynamic buffer calculated', {
        avgPriorityFee,
        buffer,
        feeMultiplier: feeMultiplier.toFixed(2),
      });

      return buffer;

    } catch (error) {
      this.logger.warn('Failed to calculate dynamic buffer, using minimum', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return this.config.minBufferSol!;
    }
  }

  /**
   * Check balances of all wallets
   */
  async checkBalances(
    wallets: Keypair[],
    tokenMint?: PublicKey
  ): Promise<WalletBalance[]> {
    this.logger.info('Checking wallet balances', { count: wallets.length });

    const balances: WalletBalance[] = [];
    
    // Calculate dynamic buffer for threshold
    const dynamicBuffer = await this.calculateDynamicBuffer();
    const thresholdLamports = (this.config.autoFundThresholdSol + dynamicBuffer) * LAMPORTS_PER_SOL;

    for (const wallet of wallets) {
      try {
        const solBalance = await this.connection.getBalance(wallet.publicKey);
        let tokenBalance = new BN(0);

        if (tokenMint) {
          try {
            const tokenAccount = await getAssociatedTokenAddress(
              tokenMint,
              wallet.publicKey
            );
            const tokenAccountInfo = await this.connection.getTokenAccountBalance(
              tokenAccount
            );
            tokenBalance = new BN(tokenAccountInfo.value.amount);
          } catch {
            // Token account doesn't exist yet
            tokenBalance = new BN(0);
          }
        }

        const needsFunding = solBalance < thresholdLamports;

        balances.push({
          publicKey: wallet.publicKey,
          solBalance: new BN(solBalance),
          tokenBalance,
          needsFunding,
        });
      } catch (error) {
        this.logger.error('Failed to check wallet balance', {
          wallet: wallet.publicKey.toString(),
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    const needsFundingCount = balances.filter((b) => b.needsFunding).length;
    this.logger.info('Balance check completed', {
      total: balances.length,
      needsFunding: needsFundingCount,
    });

    return balances;
  }

  /**
   * Auto-fund wallets that are below threshold
   */
  async autoFundWallets(
    masterWallet: Keypair,
    wallets: Keypair[],
    tokenMint?: PublicKey
  ): Promise<void> {
    this.logger.info('Starting auto-funding', {
      masterWallet: masterWallet.publicKey.toString(),
      walletCount: wallets.length,
    });

    // Check which wallets need funding
    const balances = await this.checkBalances(wallets, tokenMint);
    const walletsToFund = balances.filter((b) => b.needsFunding);

    if (walletsToFund.length === 0) {
      this.logger.info('No wallets need funding');
      return;
    }

    this.logger.info('Wallets need funding', { count: walletsToFund.length });

    // Fund SOL in batches
    await this.distributeSolBatch(
      masterWallet,
      walletsToFund.map((b) => b.publicKey),
      this.config.fundingAmountSol
    );

    // Fund tokens if specified
    if (tokenMint && this.config.fundingAmountToken) {
      await this.distributeTokensBatch(
        masterWallet,
        walletsToFund.map((b) => b.publicKey),
        tokenMint,
        this.config.fundingAmountToken
      );
    }

    this.logger.info('Auto-funding completed');
  }

  /**
   * Distribute SOL to multiple wallets in batches
   */
  async distributeSolBatch(
    from: Keypair,
    to: PublicKey[],
    amountSol: number
  ): Promise<string[]> {
    this.logger.info('Distributing SOL', {
      from: from.publicKey.toString(),
      recipients: to.length,
      amountPerWallet: amountSol,
    });

    const signatures: string[] = [];
    const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

    // Process in batches to avoid transaction size limits
    for (let i = 0; i < to.length; i += this.config.batchSize) {
      const batch = to.slice(i, i + this.config.batchSize);

      try {
        const batchSignatures = await this.sendSolBatch(from, batch, amountLamports);
        signatures.push(...batchSignatures);

        this.logger.info('SOL batch distributed', {
          batch: Math.floor(i / this.config.batchSize) + 1,
          recipients: batch.length,
        });
      } catch (error) {
        this.logger.error('Failed to distribute SOL batch', {
          batch: Math.floor(i / this.config.batchSize) + 1,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        throw error;
      }
    }

    this.logger.info('SOL distribution completed', {
      totalRecipients: to.length,
      totalAmount: amountSol * to.length,
      transactions: signatures.length,
    });

    return signatures;
  }

  /**
   * Distribute tokens to multiple wallets in batches
   */
  async distributeTokensBatch(
    from: Keypair,
    to: PublicKey[],
    tokenMint: PublicKey,
    amount: BN
  ): Promise<string[]> {
    this.logger.info('Distributing tokens', {
      from: from.publicKey.toString(),
      recipients: to.length,
      tokenMint: tokenMint.toString(),
      amount: amount.toString(),
    });

    const signatures: string[] = [];

    // Get source token account
    const sourceTokenAccount = await getAssociatedTokenAddress(
      tokenMint,
      from.publicKey
    );

    // Process in batches
    for (let i = 0; i < to.length; i += this.config.batchSize) {
      const batch = to.slice(i, i + this.config.batchSize);

      try {
        const batchSignatures = await this.sendTokenBatch(
          from,
          batch,
          tokenMint,
          sourceTokenAccount,
          amount
        );
        signatures.push(...batchSignatures);

        this.logger.info('Token batch distributed', {
          batch: Math.floor(i / this.config.batchSize) + 1,
          recipients: batch.length,
        });
      } catch (error) {
        this.logger.error('Failed to distribute token batch', {
          batch: Math.floor(i / this.config.batchSize) + 1,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        throw error;
      }
    }

    this.logger.info('Token distribution completed', {
      totalRecipients: to.length,
      transactions: signatures.length,
    });

    return signatures;
  }

  /**
   * Send SOL to multiple recipients in a single transaction
   */
  private async sendSolBatch(
    from: Keypair,
    to: PublicKey[],
    amountLamports: number
  ): Promise<string[]> {
    const signatures: string[] = [];

    // Solana transaction can fit ~10-12 transfers
    const maxPerTx = 10;

    for (let i = 0; i < to.length; i += maxPerTx) {
      const batch = to.slice(i, i + maxPerTx);

      const tx = new Transaction();

      for (const recipient of batch) {
        tx.add(
          SystemProgram.transfer({
            fromPubkey: from.publicKey,
            toPubkey: recipient,
            lamports: amountLamports,
          })
        );
      }

      const signature = await pRetry(
        async () => {
          return await sendAndConfirmTransaction(this.connection, tx, [from], {
            commitment: 'confirmed',
            skipPreflight: false,
          });
        },
        {
          retries: this.config.maxRetries,
          minTimeout: 2000,
          onFailedAttempt: (error) => {
            this.logger.warn('SOL transfer attempt failed', {
              attempt: error.attemptNumber,
              retriesLeft: error.retriesLeft,
            });
          },
        }
      );

      signatures.push(signature);
    }

    return signatures;
  }

  /**
   * Send tokens to multiple recipients
   */
  private async sendTokenBatch(
    from: Keypair,
    to: PublicKey[],
    tokenMint: PublicKey,
    sourceTokenAccount: PublicKey,
    amount: BN
  ): Promise<string[]> {
    const signatures: string[] = [];

    for (const recipient of to) {
      try {
        // Get or create destination token account
        const destTokenAccount = await getAssociatedTokenAddress(
          tokenMint,
          recipient
        );

        const tx = new Transaction();

        // Check if destination account exists
        const accountInfo = await this.connection.getAccountInfo(destTokenAccount);

        if (!accountInfo) {
          // Create associated token account
          tx.add(
            createAssociatedTokenAccountInstruction(
              from.publicKey,
              destTokenAccount,
              recipient,
              tokenMint
            )
          );
        }

        // Add transfer instruction
        tx.add(
          createTransferInstruction(
            sourceTokenAccount,
            destTokenAccount,
            from.publicKey,
            BigInt(amount.toString())
          )
        );

        const signature = await pRetry(
          async () => {
            return await sendAndConfirmTransaction(this.connection, tx, [from], {
              commitment: 'confirmed',
              skipPreflight: false,
            });
          },
          {
            retries: this.config.maxRetries,
            minTimeout: 2000,
          }
        );

        signatures.push(signature);
      } catch (error) {
        this.logger.error('Failed to send tokens to recipient', {
          recipient: recipient.toString(),
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        throw error;
      }
    }

    return signatures;
  }

  /**
   * Emergency funding - fund all wallets immediately
   */
  async emergencyFund(
    masterWallet: Keypair,
    wallets: Keypair[],
    amountSol: number
  ): Promise<void> {
    this.logger.warn('Emergency funding initiated', {
      walletCount: wallets.length,
      amountPerWallet: amountSol,
    });

    await this.distributeSolBatch(
      masterWallet,
      wallets.map((w) => w.publicKey),
      amountSol
    );

    this.logger.info('Emergency funding completed');
  }

  /**
   * Get total funding cost
   */
  calculateFundingCost(walletCount: number): number {
    return this.config.fundingAmountSol * walletCount;
  }

  /**
   * Verify master wallet has sufficient balance
   */
  async verifyMasterBalance(
    masterWallet: Keypair,
    walletsToFund: number
  ): Promise<boolean> {
    const balance = await this.connection.getBalance(masterWallet.publicKey);
    const required = this.calculateFundingCost(walletsToFund) * LAMPORTS_PER_SOL;

    const hasEnough = balance >= required;

    if (!hasEnough) {
      this.logger.error('Insufficient master wallet balance', {
        balance: balance / LAMPORTS_PER_SOL,
        required: required / LAMPORTS_PER_SOL,
      });
    }

    return hasEnough;
  }
}
