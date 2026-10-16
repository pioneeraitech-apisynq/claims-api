import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { closeRedis } from './cache/redis.client';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable NestJS shutdown lifecycle hooks so the handlers below are called
  // when the process receives SIGTERM / SIGINT (e.g. Kubernetes rolling update).
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

  // Gracefully close the Redis connection when the process is asked to shut
  // down, ensuring in-flight commands are flushed before the socket closes.
  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`claims-api received ${signal} — closing Redis connection`);
    await closeRedis();
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

bootstrap();
