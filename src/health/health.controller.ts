import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { getRedis } from '../cache/redis.client';

@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  /**
   * GET /health
   *
   * Reports the liveness of the process and of the two stateful dependencies
   * the service cannot serve traffic without: MongoDB and Redis.
   */
  @Get()
  async check() {
    const mongo = this.connection.readyState === 1 ? 'up' : 'down';

    let redis = 'down';
    try {
      const pong = await getRedis().ping();
      redis = pong === 'PONG' ? 'up' : 'down';
    } catch {
      redis = 'down';
    }

    return {
      status: mongo === 'up' && redis === 'up' ? 'ok' : 'degraded',
      service: 'claims-api',
      dependencies: { mongodb: mongo, redis },
      checkedAt: new Date().toISOString(),
    };
  }
}
