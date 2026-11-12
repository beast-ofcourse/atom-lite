import { parentPort, workerData } from "node:worker_threads";
import { CheckpointStore } from "./checkpoint-store.js";

interface WorkerData {
  workspace: string;
  sessionId: string;
  options: {
    maxCheckpointBytes?: number;
    maxCheckpoints?: number;
    maxCheckpointFiles?: number;
    enabled?: boolean;
  };
  turn: number;
  label?: string;
}

const data = workerData as WorkerData | undefined;

try {
  if (!data) throw new Error("missing worker data");
  const store = new CheckpointStore(
    data.workspace,
    data.sessionId,
    data.options,
  );
  const manifest = store.create(data.turn, data.label);
  parentPort?.postMessage({ ok: true, manifest });
} catch (err) {
  parentPort?.postMessage({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  });
}
