import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClaimsModule } from './claims/claims.module';
import { HealthController } from './health/health.controller';

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  throw new Error(
    'MONGODB_URI environment variable is not set. ' +
      'Refusing to start without an explicit database URI.',
  );
}

@Module({
  imports: [
    MongooseModule.forRoot(mongoUri, {
      tls: true,
      tlsAllowInvalidCertificates: false,
    }),
    ClaimsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
