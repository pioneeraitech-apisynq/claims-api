import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClaimsModule } from './claims/claims.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    MongooseModule.forRoot(
      process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/claims',
      {
        writeConcern: { w: 'majority', journal: true },
        readConcern: { level: 'majority' },
      },
    ),
    ClaimsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
