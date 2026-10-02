import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClaimsModule } from './claims/claims.module';
import { HealthController } from './health/health.controller';

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  throw new Error(
    'MONGODB_URI environment variable is required but was not set. ' +
      'Refusing to start without an explicit connection string.',
  );
}

@Module({
  imports: [
    MongooseModule.forRoot(mongoUri, {
      tls: true,
    }),
    ClaimsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
