import { Module, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Injectable } from '@nestjs/common';
import { ClaimsModule } from './claims/claims.module';
import { HealthController } from './health/health.controller';
import { connectRedis, closeRedis } from './cache/redis.client';

/**
 * Manages the Redis connection inside the NestJS DI lifecycle so that:
 *  - the TCP connection is established once during app bootstrap (OnModuleInit),
 *    making startup failures visible as clean errors rather than unhandled
 *    promise rejections (finding 4); and
 *  - the connection is gracefully drained on SIGTERM/SIGINT via quit()
 *    before the process exits (finding 2).
 */
@Injectable()
class RedisLifecycleService implements OnModuleInit, OnApplicationShutdown {
  async onModuleInit(): Promise<void> {
    await connectRedis();
  }

  async onApplicationShutdown(): Promise<void> {
    await closeRedis();
  }
}

@Module({
  imports: [
    MongooseModule.forRoot(
      process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/claims',
    ),
    ClaimsModule,
  ],
  controllers: [HealthController],
  providers: [RedisLifecycleService],
})
export class AppModule {}
