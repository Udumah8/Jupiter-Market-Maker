/**
 * Encryption Manager - Secure Wallet Storage
 * AES-256-GCM encryption for wallet private keys
 */

import crypto from 'crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Logger } from './Logger.js';

export interface EncryptedWallet {
  publicKey: string;
  encryptedData: string;
  iv: string;
  authTag: string;
  index: number;
}

export interface WalletData {
  secretKey: string;
  publicKey: string;
  derivationPath?: string;
  index: number;
}

export class EncryptionManager {
  private logger: Logger;
  private encryptionKey: Buffer;
  private algorithm = 'aes-256-gcm';

  constructor(encryptionKey: string, logger: Logger) {
    this.logger = logger;
    
    // Ensure encryption key is 32 bytes
    if (encryptionKey.length !== 32) {
      throw new Error('Encryption key must be exactly 32 characters');
    }

    this.encryptionKey = Buffer.from(encryptionKey, 'utf8');
  }

  /**
   * Encrypt wallet data
   */
  encryptWallet(keypair: Keypair, index: number, derivationPath?: string): EncryptedWallet {
    try {
      const walletData: WalletData = {
        secretKey: bs58.encode(keypair.secretKey),
        publicKey: keypair.publicKey.toString(),
        derivationPath,
        index,
      };

      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv(this.algorithm, this.encryptionKey, iv) as crypto.CipherGCM;

      const plaintext = JSON.stringify(walletData);
      let encrypted = cipher.update(plaintext, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      const authTag = cipher.getAuthTag();

      return {
        publicKey: keypair.publicKey.toString(),
        encryptedData: encrypted,
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        index,
      };
    } catch (error) {
      this.logger.error('Failed to encrypt wallet', {
        index,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Decrypt wallet data
   */
  decryptWallet(encrypted: EncryptedWallet): Keypair {
    try {
      const iv = Buffer.from(encrypted.iv, 'hex');
      const authTag = Buffer.from(encrypted.authTag, 'hex');
      const decipher = crypto.createDecipheriv(this.algorithm, this.encryptionKey, iv) as crypto.DecipherGCM;
      
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encrypted.encryptedData, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      const walletData: WalletData = JSON.parse(decrypted);
      const secretKey = bs58.decode(walletData.secretKey);

      return Keypair.fromSecretKey(secretKey);
    } catch (error) {
      this.logger.error('Failed to decrypt wallet', {
        publicKey: encrypted.publicKey,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw new Error('Decryption failed - invalid encryption key or corrupted data');
    }
  }

  /**
   * Encrypt multiple wallets in batch
   */
  encryptWalletsBatch(
    wallets: Array<{ keypair: Keypair; index: number; derivationPath?: string }>
  ): EncryptedWallet[] {
    this.logger.info('Encrypting wallets batch', { count: wallets.length });

    const encrypted: EncryptedWallet[] = [];

    for (const wallet of wallets) {
      try {
        const encryptedWallet = this.encryptWallet(
          wallet.keypair,
          wallet.index,
          wallet.derivationPath
        );
        encrypted.push(encryptedWallet);
      } catch (error) {
        this.logger.error('Failed to encrypt wallet in batch', {
          index: wallet.index,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        throw error;
      }
    }

    this.logger.info('Wallet batch encryption completed', {
      count: encrypted.length,
    });

    return encrypted;
  }

  /**
   * Decrypt multiple wallets in batch
   */
  decryptWalletsBatch(encrypted: EncryptedWallet[]): Keypair[] {
    this.logger.info('Decrypting wallets batch', { count: encrypted.length });

    const decrypted: Keypair[] = [];

    for (const wallet of encrypted) {
      try {
        const keypair = this.decryptWallet(wallet);
        decrypted.push(keypair);
      } catch (error) {
        this.logger.error('Failed to decrypt wallet in batch', {
          publicKey: wallet.publicKey,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        throw error;
      }
    }

    this.logger.info('Wallet batch decryption completed', {
      count: decrypted.length,
    });

    return decrypted;
  }

  /**
   * Verify encryption/decryption works correctly
   */
  async verifyEncryption(keypair: Keypair, index: number): Promise<boolean> {
    try {
      const encrypted = this.encryptWallet(keypair, index);
      const decrypted = this.decryptWallet(encrypted);

      return decrypted.publicKey.equals(keypair.publicKey);
    } catch (error) {
      this.logger.error('Encryption verification failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Change encryption key (re-encrypt all wallets)
   */
  async reEncryptWallets(
    encrypted: EncryptedWallet[],
    newEncryptionKey: string
  ): Promise<EncryptedWallet[]> {
    this.logger.info('Re-encrypting wallets with new key', {
      count: encrypted.length,
    });

    // Decrypt with old key
    const decrypted = this.decryptWalletsBatch(encrypted);

    // Create new encryption manager with new key
    const newManager = new EncryptionManager(newEncryptionKey, this.logger);

    // Encrypt with new key
    const reEncrypted = newManager.encryptWalletsBatch(
      decrypted.map((keypair, i) => ({
        keypair,
        index: encrypted[i].index,
      }))
    );

    this.logger.info('Re-encryption completed', {
      count: reEncrypted.length,
    });

    return reEncrypted;
  }

  /**
   * Export encrypted wallets to JSON
   */
  exportToJSON(encrypted: EncryptedWallet[]): string {
    return JSON.stringify(encrypted, null, 2);
  }

  /**
   * Import encrypted wallets from JSON
   */
  importFromJSON(json: string): EncryptedWallet[] {
    try {
      const data = JSON.parse(json);
      
      if (!Array.isArray(data)) {
        throw new Error('Invalid JSON format - expected array');
      }

      // Validate structure
      for (const wallet of data) {
        if (!wallet.publicKey || !wallet.encryptedData || !wallet.iv || !wallet.authTag) {
          throw new Error('Invalid wallet data structure');
        }
      }

      return data;
    } catch (error) {
      this.logger.error('Failed to import wallets from JSON', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Generate secure encryption key
   */
  static generateEncryptionKey(): string {
    return crypto.randomBytes(32).toString('base64').slice(0, 32);
  }

  /**
   * Validate encryption key format
   */
  static validateEncryptionKey(key: string): boolean {
    return key.length === 32;
  }
}
