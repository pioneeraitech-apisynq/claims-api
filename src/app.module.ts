import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClaimsModule } from './claims/claims.module';
import { HealthController } from './health/health.controller';

// Fail fast if no authenticated Atlas URI is provided. The insecure
// unauthenticated local fallback has been removed intentionally — see
// MongoDB Atlas enterprise security best-practice guidance.
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  throw new Error(
    'MONGODB_URI environment variable is not set. ' +
      'Supply a valid MongoDB Atlas connection string with credentials and TLS.',
  );
}

@Module({
  imports: [
    MongooseModule.forRoot(mongoUri),
    ClaimsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
