import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as service from "../../apps/rolepilot-web-service/dist/index.js";
import { runResumeVerticalSlice } from "../../apps/rolepilot-engine/dist/index.js";
import { fixtures } from "./fixtures.mjs";

/** Real HTTP, Supabase repositories, Storage and workers. Only provider output is replayed. */
export async function createInstance(settings, saved, which = "A", options = {}) {
  const instance = which === "A" ? saved.instanceA : saved.instanceB;
  if (![saved.instanceA, saved.instanceB].includes(instance) || !instance.startsWith("w6-")) throw new Error("验收实例无效。");
  const workDir = path.join(saved.workDir, which);
  const infra = service.createSupabaseSourceInfrastructure({ ...settings, deploymentInstanceId: instance, bucket: "rolepilot-sources" });
  const gate = new service.MaintenanceGate();
  let failOnce = false;
  let failPrefix = null;
  const stores = { sources: infra.objectStore, artifacts: infra.artifactObjectStore, exports: infra.exportObjectStore };
  // The only failure injection is at the real Storage delete boundary, never SQL deletion.
  for (const store of Object.values(stores)) {
    const remove = store.remove.bind(store);
    store.remove = async (keys) => {
      if (failOnce && keys.length && (!failPrefix || keys.some((key) => key.startsWith(failPrefix)))) {
        failOnce = false;
        throw new Error("INJECTED_STORAGE_DELETE");
      }
      return remove(keys);
    };
  }
  const cleanupRepository = new service.SupabaseCleanupRepository({ client: infra.client, stores, deploymentInstanceId: instance });
  const cleanup = new service.CleanupService({ repository: cleanupRepository, stores, gate, deploymentInstanceId: instance, workDir, now: options.now });
  const runs = new service.SupabaseRunRepository({ client: infra.client, idempotencyStore: infra.idempotencyStore, deploymentInstanceId: instance });
  const events = new service.RunEventHub();
  const cancellations = new service.RunCancellationRegistry();
  let queue;
  const runService = new service.RunService({ runRepository: runs, sourceRepository: infra.repository, workDir, cancellationRegistry: cancellations, deploymentInstanceId: instance, onRunQueued: () => queue?.wake(), onRunDeleted: () => { setTimeout(() => cleanup.wake(), 0); } });
  queue = new service.InProcessRunQueue(runService);
  const results = new service.ResultService({ runs, sources: infra.repository, objects: stores.artifacts, deploymentInstanceId: instance });
  const evidence = service.createTextEvidenceObjectStore(stores.artifacts);
  const fixture = await fixtures();
  const worker = new service.InProcessRunWorker({ queue, runRepository: runs, sourceRepository: infra.repository, workDir, agentBindings: fixture.bindings(false), artifactStore: stores.artifacts, evidenceStore: evidence, cancellationRegistry: cancellations, eventHub: events, deploymentInstanceId: instance, gate, onCleanupNeeded: () => cleanup.wake(),
    runFn: async (input) => {
      // Hold the claimed execution before pipeline entry; cancellation still uses the real worker signal.
      if (input.company.company === "W6 cancel") await delay(30000, undefined, { signal: input.signal });
      return runResumeVerticalSlice({ ...input, maxOptimizationActions: 2, agentBindings: fixture.bindings(input.company.company === "W6 evidence") });
    },
  });
  const api = service.createWebApi({ gate,
    sourceApi: service.createSourceApi({ sourceService: new service.SourceService({ ...infra, deferCleanup: true, onCleanupFailed: (id) => cleanupRepository.fail({ kind: "source", id }, "CLEANUP_STORAGE_FAILED") }) }),
    draftApi: service.createDraftApi({ draftService: new service.DraftService({ repository: new service.SupabaseDraftRepository({ client: infra.client, deploymentInstanceId: instance }), deploymentInstanceId: instance }) }),
    runApi: service.createRunApi({ runService, eventHub: events, evidenceStore: evidence, deploymentInstanceId: instance, returnCleanupStatus: true }),
    resultApi: service.createResultApi({ resultService: results }),
    workbenchApi: service.createWorkbenchApi({ workbenchService: new service.WorkbenchService({
      results: new service.WorkbenchResultService({ runs, objects: stores.artifacts, deploymentInstanceId: instance }),
      documents: new service.SupabaseWorkbenchRepository({ client: infra.client, deploymentInstanceId: instance }),
    }) }),
    cleanupApi: service.createCleanupApi(cleanup),
  });
  const server = service.createSourceHttpServer(api, gate);
  gate.maintaining = (await cleanupRepository.status()).maintaining;
  if (!gate.maintaining) {
    await infra.client.rpc("rolepilot_startup_recover_sources", { p_deployment_instance_id: instance });
    await runService.startupRecoverRunning();
    await cleanupRepository.recoverInterruptedExports();
  }
  await cleanup.initialize();
  let started = false;
  return { instance, workDir, runs, stores, cleanup, gate, client: infra.client, fixture,
    failNextDelete(runId) { failOnce = true; failPrefix = runId ? `instances/${instance}/runs/${runId}/` : null; },
    async start(port = 0) {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
      worker.start(); cleanup.start(); started = true;
      return `http://127.0.0.1:${server.address().port}`;
    },
    async stop() {
      gate.maintaining = true;
      const closed = started ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();
      await worker.stop(); await cleanup.stop();
      server.closeAllConnections();
      await closed;
    },
  };
}
