import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClaimsModule } from './claims/claims.module';
import { HealthController } from './health/health.controller';

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  throw new Error(
    'MONGODB_URI environment variable is not set. ' +
      'Provide a mongodb+srv:// URI (or a mongodb:// URI with tls=true) ' +
      'so that traffic to MongoDB is encrypted in transit.',
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
