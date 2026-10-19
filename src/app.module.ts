import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClaimsModule } from './claims/claims.module';
import { HealthController } from './health/health.controller';

/**
 * MONGODB_URI must use the `mongodb+srv://` scheme with credentials embedded
 * (or supplied via MONGODB_USER / MONGODB_PASSWORD) so that Atlas / any
 * TLS-only deployment accepts the connection.  A plain `mongodb://` URI with
 * no authentication is rejected in production.
 *
 * Example:
 *   MONGODB_URI=mongodb+srv://<user>:<password>@cluster0.example.mongodb.net/claims
 */
const mongoUri =
  process.env.MONGODB_URI ||
  'mongodb+srv://127.0.0.1:27017/claims'; // must be overridden via env in all real deployments

@Module({
  imports: [
    MongooseModule.forRoot(mongoUri, {
      // ── TLS / authentication ────────────────────────────────────────────────
      // `mongodb+srv://` URIs negotiate TLS automatically; set tls:true as an
      // explicit safeguard when a plain URI is accidentally supplied.
      tls: true,

      // ── Connection pool ─────────────────────────────────────────────────────
      // Default Mongoose 8 pool (5) is too small for concurrent claim ingestion.
      // Tune via env so staging / prod can differ without code changes.
      maxPoolSize: process.env.MONGODB_MAX_POOL_SIZE
        ? parseInt(process.env.MONGODB_MAX_POOL_SIZE, 10)
        : 20,

      // ── Timeouts ────────────────────────────────────────────────────────────
      // Fail fast on network partition rather than waiting 30 s; prevents
      // cascading request queues during a MongoDB outage.
      serverSelectionTimeoutMS: process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS
        ? parseInt(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS, 10)
        : 5_000,
      connectTimeoutMS: process.env.MONGODB_CONNECT_TIMEOUT_MS
        ? parseInt(process.env.MONGODB_CONNECT_TIMEOUT_MS, 10)
        : 10_000,
      socketTimeoutMS: process.env.MONGODB_SOCKET_TIMEOUT_MS
        ? parseInt(process.env.MONGODB_SOCKET_TIMEOUT_MS, 10)
        : 45_000,

      // ── Retryable writes ────────────────────────────────────────────────────
      // Required for Atlas and strongly recommended for replica sets; pairs
      // with the session transactions added in claims.service.ts.
      retryWrites: true,
    }),
    ClaimsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
