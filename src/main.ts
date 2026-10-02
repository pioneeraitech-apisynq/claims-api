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

  // Finding #6: ensure NestJS graceful-shutdown signals also close the Redis
  // connection so the process doesn't hang and Redis doesn't log unclean
  // disconnects.
  app.enableShutdownHooks();

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3003;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`claims-api listening on port ${port}`);

  const cleanup = async () => {
    await app.close();
    await closeRedis();
  };

  process.once('SIGTERM', cleanup);
  process.once('SIGINT', cleanup);
}

bootstrap();
