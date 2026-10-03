import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClaimsModule } from './claims/claims.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    MongooseModule.forRoot(
      process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/claims',
      {
        // Guarantee durability on primary failover for settlement writes.
        retryWrites: true,
        w: 'majority',
        // Fail fast rather than hanging indefinitely on connection issues.
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000,
      },
    ),
    ClaimsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
