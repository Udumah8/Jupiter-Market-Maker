
import { Connection } from '@solana/web3.js';
import { IAppConfig } from './AppConfig.js';
import { logger } from './Logger.js';

interface RpcEndpoint {
  url: string;
  wsUrl: string;
  connection: Connection;
  isHealthy: boolean;
  latency: number;
  failureCount: number;
}

export class RPCManager {
  private endpoints: RpcEndpoint[] = [];
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(private config: IAppConfig) {}

  public async initialize(): Promise<void> {
    this.endpoints = this.config.RPC_URLS.map(url => {
      const wsUrl = url.replace(/^http/, 'ws');
      return {
        url,
        wsUrl,
        connection: new Connection(url, {
          commitment: 'confirmed',
          wsEndpoint: wsUrl,
        }),
        isHealthy: true,
        latency: -1,
        failureCount: 0,
      };
    });

    await this.performHealthChecks();
    this.healthCheckInterval = setInterval(() => this.performHealthChecks(), 30000); // Check every 30s
    logger.info('RPC Manager initialized and health checks started.');
  }

  public getConnection(): Connection {
    // Return the connection of the best (lowest latency) healthy endpoint
    const healthyEndpoints = this.endpoints.filter(e => e.isHealthy);
    if (healthyEndpoints.length === 0) {
      logger.error('No healthy RPC endpoints available!');
      // Fallback to the first one in the list
      return this.endpoints[0].connection;
    }

    healthyEndpoints.sort((a, b) => a.latency - b.latency);
    return healthyEndpoints[0].connection;
  }
  
  public getWsConnection(): Connection {
      // For websockets, we want a stable connection. We will use the round-robin best one.
      return this.getConnection();
  }
  
  public getEndpointCount(): number {
      return this.endpoints.length;
  }

  public async stop(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    // Connections don't need to be explicitly closed in web3.js v1
    logger.info('RPC Manager stopped.');
  }

  private async performHealthChecks(): Promise<void> {
    logger.debug('Performing RPC health checks...');
    await Promise.all(this.endpoints.map(async (endpoint) => {
      const startTime = Date.now();
      try {
        await endpoint.connection.getSlot();
        endpoint.latency = Date.now() - startTime;
        endpoint.isHealthy = true;
        endpoint.failureCount = 0;
        logger.debug(`RPC endpoint ${endpoint.url} is healthy with latency ${endpoint.latency}ms.`);
      } catch (error) {
        endpoint.isHealthy = false;
        endpoint.failureCount++;
        logger.warn(`RPC endpoint ${endpoint.url} is unhealthy. Failures: ${endpoint.failureCount}.`);
      }
    }));
  }
}
