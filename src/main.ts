import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { disconnectRedis } from './cache/redis.client';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Allow NestJS to listen for OS shutdown signals (SIGTERM, SIGINT) and
  // drain the Redis connection cleanly before the process exits.
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
}

// Quit the Redis connection once all in-flight commands have drained.
// This hook fires after NestJS has torn down every module.
process.on('beforeExit', () => {
  disconnectRedis().catch(() => undefined);
});

bootstrap();
