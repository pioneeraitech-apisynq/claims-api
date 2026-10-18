import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClaimsModule } from './claims/claims.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    MongooseModule.forRoot(
      process.env.MONGODB_URI ||
        'mongodb+srv://127.0.0.1/claims?retryWrites=true&w=majority',
      {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000,
        maxPoolSize: 10,
        retryWrites: true,
      },
    ),
    ClaimsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
