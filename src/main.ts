import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { closeRedis } from './cache/redis.client';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable NestJS lifecycle hooks (onModuleDestroy, etc.) and ensure the
  // shared Redis connection is closed cleanly on SIGTERM / app.close().
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

  // Close the module-level Redis singleton when the app shuts down so the
  // process does not hang waiting for an open socket (finding 1).
  app.get(AppModule); // ensure module is resolved before registering hook
  process.once('beforeExit', async () => {
    await closeRedis();
  });
}

bootstrap();
