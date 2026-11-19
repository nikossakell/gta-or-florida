import { createServer } from 'node:http';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createChallengeService } from './services/challenge.ts';
import { createContentStore } from './services/questions.ts';

const config = loadConfig();
const store = createContentStore(config.dataDir);
const service = createChallengeService({
  store,
  allowPlaceholders: config.allowPlaceholders,
  archiveDays: config.archiveDays,
  timeLimitSeconds: config.timeLimitSeconds,
});
const app = createApp({ config, service });

const server = createServer(app.handler);
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

server.listen(config.port, config.host, () => {
  const health = service.health();
  console.log(`GTA or Florida? API listening on http://${config.host}:${config.port}`);
  console.log(`  data: ${config.dataDir} (${health.questions} questions, ${health.scheduledDays} scheduled days, today ${health.todayScheduled ? 'scheduled' : 'NOT scheduled'})`);
  console.log(`  web:  ${config.webDistDir ?? 'not served (API only)'}`);
  if (config.allowPlaceholders) console.log('  ⚠ placeholder sample content is enabled (set ALLOW_PLACEHOLDER_CONTENT=false in production)');
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  app.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
