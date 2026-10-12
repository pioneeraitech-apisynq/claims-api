import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { closeRedis } from './cache/redis.client';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable NestJS lifecycle hooks (OnApplicationShutdown, etc.) and wire up
  // a graceful Redis disconnect so the server-side connection slot is released
  // immediately on SIGTERM / SIGINT rather than waiting for TCP timeout.
  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3003;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`claims-api listening on port ${port}`);

  const shutdown = async () => {
    await app.close();
    await closeRedis();
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

bootstrap();
