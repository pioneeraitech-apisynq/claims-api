import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClaimsModule } from './claims/claims.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    MongooseModule.forRoot(
      process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/claims',
      {
        // Finding #5: explicit pool sizing and timeout so the app degrades
        // gracefully under transient Atlas/MongoDB failures.
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        maxPoolSize: 20,
        // Finding #1: enforce TLS for any non-SRV fallback URI (no-op when
        // mongodb+srv:// is used, which already mandates TLS).
        tls: true,
        // Findings #1/#5: majority-acknowledged writes and automatic retries
        // are explicit here as a safety net even though they are also encoded
        // in the MONGODB_URI query string for the SRV connection.
        retryWrites: true,
        w: 'majority',
      },
    ),
    ClaimsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
