import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClaimsModule } from './claims/claims.module';
import { HealthController } from './health/health.controller';

if (!process.env.MONGODB_URI) {
  throw new Error(
    'MONGODB_URI environment variable is required. ' +
      'Set it to a mongodb+srv:// Atlas URI with credentials and TLS enabled.',
  );
}

@Module({
  imports: [
    MongooseModule.forRoot(process.env.MONGODB_URI),
    ClaimsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
