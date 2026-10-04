import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { closeRedis } from './cache/redis.client';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Gracefully drain and close the shared Redis connection on pod/process
  // termination so in-flight commands complete and the connection slot is
  // released before the TCP timeout fires (finding 3).
  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`Received ${signal}, shutting down…`);
    await app.close();
    await closeRedis();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3003;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`claims-api listening on port ${port}`);
}

bootstrap();
