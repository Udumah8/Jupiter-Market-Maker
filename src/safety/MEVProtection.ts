/**
 * MEV Protection Module
 * Protects against MEV attacks, sandwich attacks, and front-running
 */

import {
  Connection,
  Transaction,
  ComputeBudgetProgram,
  PublicKey,
  Keypair,
} from '@solana/web3.js';
import { Logger } from '../utils/Logger.js';

export interface MEVProtectionConfig {
  enablePriorityFees: boolean;
  basePriorityFee: number; // microlamports
  maxPriorityFee: number; // microlamports
  enableSimulation: boolean;
  enableSandwichDetection: boolean;
  maxSlippagePercent: number;
  computeUnitLimit: number;
}

export interface SimulationResult {
  success: boolean;
  error?: string;
  logs?: string[];
  unitsConsumed?: number;
  priceImpact?: number;
}

export interface SandwichDetection {
  detected: boolean;
  confidence: number;
  reason?: string;
}

export class MEVProtection {
  private connection: Connection;
  private logger: Logger;
  private config: MEVProtectionConfig;
  private recentPriorityFees: number[] = [];

  constructor(
    connection: Connection,
    config: MEVProtectionConfig,
    logger: Logger
  ) {
    this.connection = connection;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Optimize transaction with priority fees and compute budget
   */
  async optimizeTransaction(tx: Transaction): Promise<Transaction> {
    const optimized = new Transaction();

    // Add compute budget instructions first
    if (this.config.enablePriorityFees) {
      const priorityFee = await this.calculateOptimalPriorityFee();

      optimized.add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: this.config.computeUnitLimit,
        })
      );

      optimized.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityFee,
        })
      );

      this.logger.debug('Added priority fee', {
        priorityFee,
        computeUnitLimit: this.config.computeUnitLimit,
      });
    }

    // Add original instructions
    optimized.add(...tx.instructions);

    // Copy transaction properties
    optimized.recentBlockhash = tx.recentBlockhash;
    optimized.feePayer = tx.feePayer;

    return optimized;
  }

  /**
   * Calculate optimal priority fee based on network conditions
   */
  async calculateOptimalPriorityFee(): Promise<number> {
    try {
      // Get recent prioritization fees
      const recentFees = await this.connection.getRecentPrioritizationFees();

      if (recentFees.length === 0) {
        return this.config.basePriorityFee;
      }

      // Calculate median fee
      const fees = recentFees
        .map((f) => f.prioritizationFee)
        .filter((f) => f > 0)
        .sort((a, b) => a - b);

      if (fees.length === 0) {
        return this.config.basePriorityFee;
      }

      const median = fees[Math.floor(fees.length / 2)];

      // Add 20% buffer to median
      const optimalFee = Math.floor(median * 1.2);

      // Clamp between base and max
      const clampedFee = Math.max(
        this.config.basePriorityFee,
        Math.min(optimalFee, this.config.maxPriorityFee)
      );

      // Store for tracking
      this.recentPriorityFees.push(clampedFee);
      if (this.recentPriorityFees.length > 100) {
        this.recentPriorityFees.shift();
      }

      this.logger.debug('Calculated priority fee', {
        median,
        optimal: optimalFee,
        clamped: clampedFee,
      });

      return clampedFee;
    } catch (error) {
      this.logger.warn('Failed to calculate priority fee, using base', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return this.config.basePriorityFee;
    }
  }

  /**
   * Simulate transaction before sending
   */
  async simulateTransaction(
    tx: Transaction,
    signers: Keypair[]
  ): Promise<SimulationResult> {
    if (!this.config.enableSimulation) {
      return { success: true };
    }

    try {
      const simulation = await this.connection.simulateTransaction(tx, signers);

      if (simulation.value.err) {
        this.logger.warn('Transaction simulation failed', {
          error: JSON.stringify(simulation.value.err),
          logs: simulation.value.logs,
        });

        return {
          success: false,
          error: JSON.stringify(simulation.value.err),
          logs: simulation.value.logs || [],
        };
      }

      this.logger.debug('Transaction simulation successful', {
        unitsConsumed: simulation.value.unitsConsumed,
      });

      return {
        success: true,
        logs: simulation.value.logs || [],
        unitsConsumed: simulation.value.unitsConsumed || 0,
      };
    } catch (error) {
      this.logger.error('Transaction simulation error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Detect potential sandwich attacks
   */
  async detectSandwichAttack(
    inputMint: PublicKey,
    _outputMint: PublicKey,
    _amount: number
  ): Promise<SandwichDetection> {
    if (!this.config.enableSandwichDetection) {
      return { detected: false, confidence: 0 };
    }

    try {
      // Get recent transactions for the pair
      const signatures = await this.connection.getSignaturesForAddress(
        inputMint,
        { limit: 10 }
      );

      if (signatures.length < 3) {
        return { detected: false, confidence: 0 };
      }

      // Check for suspicious patterns
      const recentTimes = signatures.map((s) => s.blockTime || 0);
      const timeDiffs = [];

      for (let i = 1; i < recentTimes.length; i++) {
        timeDiffs.push(recentTimes[i - 1] - recentTimes[i]);
      }

      // Detect rapid consecutive transactions (potential sandwich)
      const rapidTxs = timeDiffs.filter((diff) => diff < 2).length;

      if (rapidTxs >= 2) {
        this.logger.warn('Potential sandwich attack detected', {
          rapidTransactions: rapidTxs,
          inputMint: inputMint.toString(),
        });

        return {
          detected: true,
          confidence: Math.min(rapidTxs / 3, 1),
          reason: `${rapidTxs} rapid transactions detected`,
        };
      }

      return { detected: false, confidence: 0 };
    } catch (error) {
      this.logger.debug('Sandwich detection check failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return { detected: false, confidence: 0 };
    }
  }

  /**
   * Protect transaction with all MEV protection measures
   */
  async protectTransaction(
    tx: Transaction,
    signers: Keypair[],
    inputMint?: PublicKey,
    outputMint?: PublicKey,
    amount?: number
  ): Promise<{ protected: Transaction; safe: boolean; warnings: string[] }> {
    const warnings: string[] = [];

    // 1. Optimize with priority fees
    let protectedTx = await this.optimizeTransaction(tx);

    // 2. Simulate transaction
    const simulation = await this.simulateTransaction(protectedTx, signers);

    if (!simulation.success) {
      warnings.push(`Simulation failed: ${simulation.error}`);
    }

    // 3. Check for sandwich attacks
    if (inputMint && outputMint && amount) {
      const sandwich = await this.detectSandwichAttack(
        inputMint,
        outputMint,
        amount
      );

      if (sandwich.detected) {
        warnings.push(
          `Sandwich attack detected (confidence: ${(sandwich.confidence * 100).toFixed(0)}%)`
        );
      }
    }

    const safe = warnings.length === 0;

    if (!safe) {
      this.logger.warn('Transaction protection warnings', { warnings });
    }

    return { protected: protectedTx, safe, warnings };
  }

  /**
   * Get average priority fee from recent transactions
   */
  getAveragePriorityFee(): number {
    if (this.recentPriorityFees.length === 0) {
      return this.config.basePriorityFee;
    }

    const sum = this.recentPriorityFees.reduce((a, b) => a + b, 0);
    return Math.floor(sum / this.recentPriorityFees.length);
  }

  /**
   * Adjust priority fee based on success rate
   */
  adjustPriorityFee(successRate: number): void {
    if (successRate < 0.5) {
      // Low success rate, increase priority fee
      this.config.basePriorityFee = Math.min(
        Math.floor(this.config.basePriorityFee * 1.5),
        this.config.maxPriorityFee
      );

      this.logger.info('Increased base priority fee', {
        newBaseFee: this.config.basePriorityFee,
        successRate,
      });
    } else if (successRate > 0.9) {
      // High success rate, can reduce priority fee
      this.config.basePriorityFee = Math.max(
        Math.floor(this.config.basePriorityFee * 0.9),
        1000 // Minimum 1000 microlamports
      );

      this.logger.info('Decreased base priority fee', {
        newBaseFee: this.config.basePriorityFee,
        successRate,
      });
    }
  }

  /**
   * Check if transaction should be delayed due to high MEV risk
   */
  shouldDelayTransaction(warnings: string[]): boolean {
    // Delay if sandwich attack detected with high confidence
    const sandwichWarning = warnings.find((w) =>
      w.includes('Sandwich attack detected')
    );

    if (sandwichWarning) {
      const confidenceMatch = sandwichWarning.match(/(\d+)%/);
      if (confidenceMatch) {
        const confidence = parseInt(confidenceMatch[1]);
        return confidence > 70;
      }
    }

    return false;
  }

  /**
   * Get recommended delay time in milliseconds
   */
  getRecommendedDelay(warnings: string[]): number {
    if (this.shouldDelayTransaction(warnings)) {
      // Random delay between 2-5 seconds to avoid sandwich
      return 2000 + Math.random() * 3000;
    }

    return 0;
  }
}
