import { Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClaimsModule } from './claims/claims.module';
import { HealthController } from './health/health.controller';
import { getRedis } from './cache/redis.client';

/**
 * Ensures the shared Redis singleton is properly closed on application
 * shutdown (SIGTERM, SIGINT, app.close()) so the server-side connection slot
 * is released immediately rather than left to time out.  (Finding 2)
 */
@Injectable()
class RedisLifecycleService implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await getRedis().quit();
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
