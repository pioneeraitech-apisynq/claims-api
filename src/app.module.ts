import { Module, OnApplicationShutdown } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClaimsModule } from './claims/claims.module';
import { HealthController } from './health/health.controller';
import { closeRedis } from './cache/redis.client';

@Module({
  imports: [
    MongooseModule.forRoot(
      process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/claims',
    ),
    ClaimsModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements OnApplicationShutdown {
  /**
   * Called by NestJS during graceful shutdown. Closes the Redis connection so
   * the event loop drains cleanly and the server-side socket is released.
   * (Finding 4)
   */
  async onApplicationShutdown(): Promise<void> {
    await closeRedis();
  }
}
