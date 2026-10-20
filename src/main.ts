import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { getRedis, closeRedis } from './cache/redis.client';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Eagerly initialise the Redis client at startup so that a Redis outage is
  // visible immediately (e.g. in the first health probe) rather than being
  // masked until the first request arrives (finding #7).
  getRedis();

  // Register a graceful-shutdown handler so the shared Redis TCP connection is
  // closed cleanly before the process exits (finding #5).
  process.on('SIGTERM', async () => {
    await closeRedis();
    await app.close();
  });

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3003;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`claims-api listening on port ${port}`);
}

bootstrap();
