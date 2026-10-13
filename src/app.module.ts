import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClaimsModule } from './claims/claims.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      useFactory: () => ({
        uri: process.env.MONGODB_URI,
        tls: true,
        authSource: 'admin',
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        retryWrites: true,
        retryReads: true,
      }),
    }),
    ClaimsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
