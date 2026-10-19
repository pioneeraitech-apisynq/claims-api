import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { initRedis, closeRedis } from './cache/redis.client';

async function bootstrap() {
  // Establish the Redis connection eagerly so any misconfiguration (wrong URL,
  // bad credentials, network unreachable) surfaces before the app starts
  // accepting traffic rather than inside the first request handler (finding #5).
  await initRedis();

  const app = await NestFactory.create(AppModule);

  // Ensure the Redis connection is closed cleanly on SIGTERM (finding #8).
  app.enableShutdownHooks();
  process.on('SIGTERM', async () => {
    await closeRedis();
  });

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
}

bootstrap();
