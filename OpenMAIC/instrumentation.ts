/**
 * Process-scoped startup work.
 *
 * Next calls `register` once per server instance, before it serves a request.
 * That makes it the only place in this app where a background schedule can
 * live: a route module has no such guarantee — it can be instantiated more than
 * once and gets no shutdown hook — so anything periodic started from one is
 * really started per instantiation.
 *
 * `register` must return before the server is ready, so nothing here may block
 * on I/O. Starting a timer does not.
 */
export async function register(): Promise<void> {
  // Also invoked for the Edge runtime, which has neither `pg` nor timers we
  // want; the persistence stack is Node-only.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const hasPersistence = Boolean(process.env.DATABASE_URL?.trim());
  const agentEnabled = process.env.OPENMAIC_AGENT_RUNTIME_ENABLED === 'true' ||
    process.env.OPENMAIC_AGENT_RUNTIME_ENABLED === '1';
  if (!hasPersistence && !agentEnabled) {
    if (!process.env.ACCESS_CODE?.trim()) {
      console.warn('[AccessCode] ACCESS_CODE is not set. The access-code gate is disabled for all API routes.');
    }
    return;
  }
  console.warn('[instrumentation] Durable startup runners are disabled in this development build.');
  return;

  // The asset quota, read here rather than at the first persistence request.
  // The provider that consumes it is lazy and memoised, so a malformed ceiling
  // would otherwise let the process boot, pass its health check, and then fail
  // every persistence request -- documents and runtime included -- until it was
  // fixed and the process restarted. `register` runs before the server is
  // ready, so throwing here is what makes a misconfigured deployment fail to
  // start instead of failing to work. First, so the throw cannot skip the
  // teardown registration for something this function has already started.
  const { resolveAssetQuotaBytes } = await runtimeImport<typeof import('@/lib/persistence/asset-quota')>(
    './lib/persistence/asset-quota',
  );
  resolveAssetQuotaBytes();

  // The pending-allocation window, for the same reason and at the same moment.
  // Too short is worse than malformed: it silently expires allocations whose
  // document write was still coming, so it must fail the process rather than
  // the request that discovers it.
  const { resolveAssetPendingTtlMs } = await runtimeImport<
    typeof import('@/lib/persistence/asset-pending-ttl')
  >('./lib/persistence/asset-pending-ttl');
  resolveAssetPendingTtlMs();

  // Imported dynamically so the Edge bundle never pulls in `pg`.
  const { startAssetCollectorSchedule } = await runtimeImport<
    typeof import('@/lib/persistence/asset-collector-schedule')
  >('./lib/persistence/asset-collector-schedule');
  const assetSchedule = startAssetCollectorSchedule();

  // Warn-first boot-time validation of model routing config (MODEL_ROUTES,
  // DEFAULT_MODEL, <PREFIX>_MODELS). Cheap and non-throwing: broken config
  // surfaces here as [config] warnings instead of failing at request time.
  // Imported dynamically so the Edge bundle never pulls in the fs/js-yaml
  // backed provider config it reads.
  const { validateServerConfig } = await runtimeImport<typeof import('@/lib/server/config-validation')>(
    './lib/server/config-validation',
  );
  validateServerConfig();

  let runner: { stop(): Promise<void> } | undefined;
  let extractionRunner: { stop(): Promise<void> } | undefined;
  let stopAgentEventNotifyBus: (() => Promise<void>) | null = null;
  try {
    const { isAgentRuntimeConfigured } = await runtimeImport<
      typeof import('@/lib/config/feature-flags')
    >('./lib/config/feature-flags');
    if (isAgentRuntimeConfigured()) {
      // One dedicated LISTEN connection per application instance. The HTTP
      // SSE routes and the runner share its in-process fanout registry; it is
      // not a pool client and never scales with the number of streams.
      const { startAgentEventNotifyBus } = await runtimeImport<
        typeof import('@/lib/server/agent-runtime/event-notify-bus')
      >('./lib/server/agent-runtime/event-notify-bus');
      const eventNotifyBus = startAgentEventNotifyBus();
      stopAgentEventNotifyBus = () => eventNotifyBus.stop();
      // startAgentRunner only installs a timer. Store/schema initialization is
      // retained behind the store's lazy promise and never blocks register().
      const runtime = await runtimeImport<typeof import('@/lib/server/agent-runtime/runner')>(
        './lib/server/agent-runtime/runner',
      );
      runner = runtime.startAgentRunner();
      const extraction = await runtimeImport<
        typeof import('@/lib/server/material-extraction/runner')
      >('./lib/server/material-extraction/runner');
      extractionRunner = extraction.startMaterialExtractionRunner();
    }
  } catch (error) {
    console.error('[instrumentation] Agent runtime startup failed', error);
  }

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      // Park sessions before any pool they use is closed. This preserves the
      // last durable entry-tree checkpoint for immediate takeover.
      try {
        await extractionRunner?.stop();
      } catch (error) {
        console.error('[instrumentation] Material extraction runner drain failed', error);
      }
      try {
        await runner?.stop();
      } catch (error) {
        console.error('[instrumentation] Agent runner drain failed', error);
      }
      try {
        await stopAgentEventNotifyBus?.();
      } catch (error) {
        console.error('[instrumentation] Agent event notify bus drain failed', error);
      }
      try {
        await assetSchedule?.stop();
      } catch (error) {
        console.error('[instrumentation] Asset collector drain failed', error);
      }
      const connectionString = process.env.DATABASE_URL?.trim();
      if (connectionString) {
        try {
          const { getServerPersistenceProvider } = await runtimeImport<
            typeof import('@/lib/persistence/server-provider')
          >('./lib/persistence/server-provider');
          const { pool } = await getServerPersistenceProvider(connectionString);
          await pool.end();
        } catch (error) {
          console.error('[instrumentation] Persistence pool shutdown failed', error);
        }
      }
    })();
    return shutdownPromise;
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
