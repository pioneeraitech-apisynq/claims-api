import { Module, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClaimsModule } from './claims/claims.module';
import { HealthController } from './health/health.controller';
import { closeRedis } from './cache/redis.client';

@Injectable()
class RedisShutdownService implements OnApplicationShutdown {
  async onApplicationShutdown(_signal?: string): Promise<void> {
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
  providers: [RedisShutdownService],
})
export class AppModule {}
