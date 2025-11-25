/**
 * Rug-Pull Detector
 * Monitors LP tokens, supply changes, and holder concentration
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { Logger } from '../utils/Logger.js';
import BN from 'bn.js';

export interface RugPullConfig {
  lpMonitoringEnabled: boolean;
  supplyChangeThresholdPercent: number;
  holderConcentrationThresholdPercent: number;
  checkIntervalMs: number;
  autoExitOnDetection: boolean;
}

export interface LPStatus {
  totalLiquidity: BN;
  lpTokenSupply: BN;
  lastChecked: number;
  changePercent: number;
  suspicious: boolean;
}

export interface SupplyChange {
  currentSupply: BN;
  previousSupply: BN;
  changePercent: number;
  timestamp: number;
  suspicious: boolean;
}

export interface HolderConcentration {
  topHolderPercent: number;
  top10HolderPercent: number;
  totalHolders: number;
  suspicious: boolean;
}

export interface RugPullRisk {
  level: 'low' | 'medium' | 'high' | 'critical';
  score: number; // 0-100
  reasons: string[];
  shouldExit: boolean;
}

export class RugPullDetector {
  private connection: Connection;
  private logger: Logger;
  private config: RugPullConfig;
  private lpHistory: Map<string, LPStatus[]> = new Map();
  private supplyHistory: Map<string, SupplyChange[]> = new Map();
  private monitoringIntervals: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    connection: Connection,
    config: RugPullConfig,
    logger: Logger
  ) {
    this.connection = connection;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Start monitoring a token for rug-pull indicators
   */
  startMonitoring(tokenMint: PublicKey): void {
    const mintStr = tokenMint.toString();

    if (this.monitoringIntervals.has(mintStr)) {
      this.logger.warn('Already monitoring token', { mint: mintStr });
      return;
    }

    this.logger.info('Starting rug-pull monitoring', { mint: mintStr });

    // Initial check
    this.checkToken(tokenMint);

    // Set up periodic checks
    const interval = setInterval(() => {
      this.checkToken(tokenMint);
    }, this.config.checkIntervalMs);

    this.monitoringIntervals.set(mintStr, interval);
  }

  /**
   * Stop monitoring a token
   */
  stopMonitoring(tokenMint: PublicKey): void {
    const mintStr = tokenMint.toString();
    const interval = this.monitoringIntervals.get(mintStr);

    if (interval) {
      clearInterval(interval);
      this.monitoringIntervals.delete(mintStr);
      this.logger.info('Stopped rug-pull monitoring', { mint: mintStr });
    }
  }

  /**
   * Perform comprehensive rug-pull check
   */
  async checkToken(tokenMint: PublicKey): Promise<RugPullRisk> {
    const mintStr = tokenMint.toString();

    try {
      // Run all checks in parallel
      const [lpStatus, supplyChange, holderConcentration] = await Promise.all([
        this.checkLPTokens(tokenMint),
        this.checkSupplyChanges(tokenMint),
        this.checkHolderConcentration(tokenMint),
      ]);

      // Calculate risk score
      const risk = this.calculateRisk(lpStatus, supplyChange, holderConcentration);

      if (risk.level === 'high' || risk.level === 'critical') {
        this.logger.error('RUG-PULL RISK DETECTED', {
          mint: mintStr,
          level: risk.level,
          score: risk.score,
          reasons: risk.reasons,
        });
      } else if (risk.level === 'medium') {
        this.logger.warn('Elevated rug-pull risk', {
          mint: mintStr,
          level: risk.level,
          score: risk.score,
          reasons: risk.reasons,
        });
      }

      return risk;
    } catch (error) {
      this.logger.error('Rug-pull check failed', {
        mint: mintStr,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return {
        level: 'low',
        score: 0,
        reasons: ['Check failed'],
        shouldExit: false,
      };
    }
  }

  /**
   * Monitor LP token changes
   */
  async checkLPTokens(tokenMint: PublicKey): Promise<LPStatus> {
    const mintStr = tokenMint.toString();

    try {
      // Get token supply (simplified - in production, query actual LP pools)
      const supply = await this.connection.getTokenSupply(tokenMint);
      const currentSupply = new BN(supply.value.amount);

      // Get previous status
      const history = this.lpHistory.get(mintStr) || [];
      const previous = history[history.length - 1];

      let changePercent = 0;
      let suspicious = false;

      if (previous) {
        const diff = currentSupply.sub(previous.lpTokenSupply);
        changePercent = diff.mul(new BN(100)).div(previous.lpTokenSupply).toNumber();

        // Suspicious if LP decreased by more than threshold
        if (changePercent < -this.config.lpMonitoringEnabled ? 20 : 0) {
          suspicious = true;
          this.logger.warn('Suspicious LP decrease detected', {
            mint: mintStr,
            changePercent: changePercent.toFixed(2),
          });
        }
      }

      const status: LPStatus = {
        totalLiquidity: currentSupply,
        lpTokenSupply: currentSupply,
        lastChecked: Date.now(),
        changePercent,
        suspicious,
      };

      // Store history
      history.push(status);
      if (history.length > 100) {
        history.shift();
      }
      this.lpHistory.set(mintStr, history);

      return status;
    } catch (error) {
      this.logger.debug('LP check failed', {
        mint: mintStr,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return {
        totalLiquidity: new BN(0),
        lpTokenSupply: new BN(0),
        lastChecked: Date.now(),
        changePercent: 0,
        suspicious: false,
      };
    }
  }

  /**
   * Detect supply changes (burns, mints)
   */
  async checkSupplyChanges(tokenMint: PublicKey): Promise<SupplyChange> {
    const mintStr = tokenMint.toString();

    try {
      const supply = await this.connection.getTokenSupply(tokenMint);
      const currentSupply = new BN(supply.value.amount);

      // Get previous supply
      const history = this.supplyHistory.get(mintStr) || [];
      const previous = history[history.length - 1];

      let changePercent = 0;
      let suspicious = false;

      if (previous) {
        const diff = currentSupply.sub(previous.currentSupply);
        changePercent = diff
          .mul(new BN(100))
          .div(previous.currentSupply)
          .toNumber();

        // Suspicious if supply changed by more than threshold
        if (Math.abs(changePercent) > this.config.supplyChangeThresholdPercent) {
          suspicious = true;
          this.logger.warn('Suspicious supply change detected', {
            mint: mintStr,
            changePercent: changePercent.toFixed(2),
          });
        }
      }

      const change: SupplyChange = {
        currentSupply,
        previousSupply: previous?.currentSupply || new BN(0),
        changePercent,
        timestamp: Date.now(),
        suspicious,
      };

      // Store history
      history.push(change);
      if (history.length > 100) {
        history.shift();
      }
      this.supplyHistory.set(mintStr, history);

      return change;
    } catch (error) {
      this.logger.debug('Supply check failed', {
        mint: mintStr,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return {
        currentSupply: new BN(0),
        previousSupply: new BN(0),
        changePercent: 0,
        timestamp: Date.now(),
        suspicious: false,
      };
    }
  }

  /**
   * Analyze holder concentration
   */
  async checkHolderConcentration(
    tokenMint: PublicKey
  ): Promise<HolderConcentration> {
    const mintStr = tokenMint.toString();

    try {
      // Get largest token accounts
      const largestAccounts = await this.connection.getTokenLargestAccounts(
        tokenMint
      );

      if (largestAccounts.value.length === 0) {
        return {
          topHolderPercent: 0,
          top10HolderPercent: 0,
          totalHolders: 0,
          suspicious: false,
        };
      }

      // Get total supply
      const supply = await this.connection.getTokenSupply(tokenMint);
      const totalSupply = new BN(supply.value.amount);

      // Calculate top holder percentage
      const topHolder = new BN(largestAccounts.value[0].amount);
      const topHolderPercent = topHolder
        .mul(new BN(100))
        .div(totalSupply)
        .toNumber();

      // Calculate top 10 holders percentage
      const top10Amount = largestAccounts.value
        .slice(0, 10)
        .reduce((sum, acc) => sum.add(new BN(acc.amount)), new BN(0));
      const top10HolderPercent = top10Amount
        .mul(new BN(100))
        .div(totalSupply)
        .toNumber();

      // Suspicious if concentration is too high
      const suspicious =
        topHolderPercent > this.config.holderConcentrationThresholdPercent ||
        top10HolderPercent > 80;

      if (suspicious) {
        this.logger.warn('High holder concentration detected', {
          mint: mintStr,
          topHolderPercent: topHolderPercent.toFixed(2),
          top10HolderPercent: top10HolderPercent.toFixed(2),
        });
      }

      return {
        topHolderPercent,
        top10HolderPercent,
        totalHolders: largestAccounts.value.length,
        suspicious,
      };
    } catch (error) {
      this.logger.debug('Holder concentration check failed', {
        mint: mintStr,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return {
        topHolderPercent: 0,
        top10HolderPercent: 0,
        totalHolders: 0,
        suspicious: false,
      };
    }
  }

  /**
   * Calculate overall rug-pull risk
   */
  private calculateRisk(
    lpStatus: LPStatus,
    supplyChange: SupplyChange,
    holderConcentration: HolderConcentration
  ): RugPullRisk {
    let score = 0;
    const reasons: string[] = [];

    // LP decrease (0-40 points)
    if (lpStatus.suspicious) {
      const lpScore = Math.min(Math.abs(lpStatus.changePercent) * 2, 40);
      score += lpScore;
      reasons.push(
        `LP decreased by ${Math.abs(lpStatus.changePercent).toFixed(2)}%`
      );
    }

    // Supply change (0-30 points)
    if (supplyChange.suspicious) {
      const supplyScore = Math.min(
        Math.abs(supplyChange.changePercent) * 1.5,
        30
      );
      score += supplyScore;
      reasons.push(
        `Supply changed by ${Math.abs(supplyChange.changePercent).toFixed(2)}%`
      );
    }

    // Holder concentration (0-30 points)
    if (holderConcentration.suspicious) {
      const concentrationScore = Math.min(
        holderConcentration.topHolderPercent * 0.5,
        30
      );
      score += concentrationScore;
      reasons.push(
        `Top holder owns ${holderConcentration.topHolderPercent.toFixed(2)}%`
      );
    }

    // Determine risk level
    let level: 'low' | 'medium' | 'high' | 'critical';
    if (score >= 80) {
      level = 'critical';
    } else if (score >= 60) {
      level = 'high';
    } else if (score >= 40) {
      level = 'medium';
    } else {
      level = 'low';
    }

    // Should exit if critical or high risk with auto-exit enabled
    const shouldExit =
      this.config.autoExitOnDetection &&
      (level === 'critical' || level === 'high');

    return {
      level,
      score,
      reasons,
      shouldExit,
    };
  }

  /**
   * Get monitoring status for a token
   */
  isMonitoring(tokenMint: PublicKey): boolean {
    return this.monitoringIntervals.has(tokenMint.toString());
  }

  /**
   * Get all monitored tokens
   */
  getMonitoredTokens(): PublicKey[] {
    return Array.from(this.monitoringIntervals.keys()).map(
      (str) => new PublicKey(str)
    );
  }

  /**
   * Stop all monitoring
   */
  stopAllMonitoring(): void {
    for (const [mint, interval] of this.monitoringIntervals.entries()) {
      clearInterval(interval);
      this.logger.info('Stopped monitoring', { mint });
    }
    this.monitoringIntervals.clear();
  }
}
