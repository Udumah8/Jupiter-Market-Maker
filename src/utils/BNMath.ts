/**
 * Safe BigNumber Math Utilities
 * All token amount calculations MUST use BN to avoid precision loss
 */

import BN from 'bn.js';

export class BNMath {
  /**
   * Convert UI amount to token amount (smallest units)
   * NEVER use floating point for this conversion
   */
  static toTokenAmount(uiAmount: number, decimals: number): BN {
    // Convert to string to avoid floating point issues
    const amountStr = uiAmount.toFixed(decimals);
    const [whole = '0', fraction = ''] = amountStr.split('.');
    
    // Pad fraction to exact decimals
    const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
    
    // Combine and create BN
    const tokenAmountStr = whole + paddedFraction;
    return new BN(tokenAmountStr);
  }

  /**
   * Convert token amount to UI amount
   * Returns string to maintain precision
   */
  static toUIAmount(tokenAmount: BN, decimals: number): string {
    const amountStr = tokenAmount.toString().padStart(decimals + 1, '0');
    const whole = amountStr.slice(0, -decimals) || '0';
    const fraction = amountStr.slice(-decimals);
    
    return `${whole}.${fraction}`;
  }

  /**
   * Convert token amount to UI amount as number
   * WARNING: May lose precision for large amounts
   */
  static toUIAmountNumber(tokenAmount: BN, decimals: number): number {
    const uiStr = this.toUIAmount(tokenAmount, decimals);
    return parseFloat(uiStr);
  }

  /**
   * Calculate price from input/output amounts
   * price = inAmount / outAmount (in UI terms)
   */
  static calculatePrice(
    inAmount: BN,
    outAmount: BN,
    inDecimals: number,
    outDecimals: number
  ): number {
    if (inAmount.isZero() || outAmount.isZero()) {
      return 0;
    }

    // Convert to UI amounts for price calculation
    const inUI = this.toUIAmountNumber(inAmount, inDecimals);
    const outUI = this.toUIAmountNumber(outAmount, outDecimals);

    if (!isFinite(inUI) || !isFinite(outUI) || outUI === 0) {
      return 0;
    }

    const price = inUI / outUI;
    
    if (!isFinite(price) || price <= 0) {
      return 0;
    }

    return price;
  }

  /**
   * Multiply BN by a decimal factor safely
   * factor should be between 0 and 10
   */
  static multiplyByFactor(amount: BN, factor: number, decimals: number = 6): BN {
    if (factor === 1) return amount;
    
    // Convert factor to BN with precision
    const factorBN = this.toTokenAmount(factor, decimals);
    const divisor = new BN(10).pow(new BN(decimals));
    
    // Multiply then divide to maintain precision
    return amount.mul(factorBN).div(divisor);
  }

  /**
   * Calculate percentage of amount
   */
  static percentage(amount: BN, percent: number): BN {
    const percentBN = new BN(Math.floor(percent * 100));
    return amount.mul(percentBN).div(new BN(10000));
  }

  /**
   * Safe division with rounding
   */
  static divide(numerator: BN, denominator: BN): BN {
    if (denominator.isZero()) {
      throw new Error('Division by zero');
    }
    return numerator.div(denominator);
  }

  /**
   * Check if amount is within tolerance of target
   */
  static isWithinTolerance(
    amount: BN,
    target: BN,
    tolerancePercent: number
  ): boolean {
    if (target.isZero()) return amount.isZero();
    
    const diff = amount.sub(target).abs();
    const tolerance = this.percentage(target, tolerancePercent);
    
    return diff.lte(tolerance);
  }

  /**
   * Get minimum of two BN values
   */
  static min(a: BN, b: BN): BN {
    return a.lt(b) ? a : b;
  }

  /**
   * Get maximum of two BN values
   */
  static max(a: BN, b: BN): BN {
    return a.gt(b) ? a : b;
  }

  /**
   * Clamp value between min and max
   */
  static clamp(value: BN, min: BN, max: BN): BN {
    if (value.lt(min)) return min;
    if (value.gt(max)) return max;
    return value;
  }
}
