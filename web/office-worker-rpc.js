export class Transfer {
  constructor(value, transfer = []) {
    this.value = value;
    this.transfer = transfer;
  }
}

export function workerAsset(pkg, path) {
  const token = new URL(self.location.href).searchParams.get("token") ?? "";
  return `/engine/@betteroffice/${pkg}/${path}?token=${encodeURIComponent(token)}`;
}

export function lazyLoad(loader) {
  let pending;
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(loader);
      pending.catch(() => {
        pending = undefined;
      });
    }
    return pending;
  };
}

export function stateGuard(getState, message) {
  return () => {
    const state = getState();
    if (!state) throw new Error(message);
    return state;
  };
}

export function createRpcClient(worker, onCrash = () => {}) {
  const pending = new Map();
  let closed = false;
  let nextId = 0;

  const rejectAll = (error) => {
    for (const call of pending.values()) {
      call.signal?.removeEventListener("abort", call.abort);
      call.reject(error);
    }
    pending.clear();
  };

  const crash = (message) => {
    if (closed) return;
    closed = true;
    rejectAll(new Error(message));
    onCrash();
  };

  worker.onmessage = (event) => {
    const reply = event.data;
    if (!reply) return;
    const call = pending.get(reply.id);
    if (!call) return;
    pending.delete(reply.id);
    call.signal?.removeEventListener("abort", call.abort);
    if (reply.ok) call.resolve(reply.value);
    else call.reject(new Error(reply.error || "Office engine failed"));
  };
  worker.onerror = (event) => crash(event.message || "Office engine stopped");
  worker.onmessageerror = () => crash("Office engine sent an unreadable reply");

  return {
    call(method, input, { signal, transfer } = {}) {
      if (closed) return Promise.reject(new Error("Office worker closed"));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const abort = () => {
          const call = pending.get(id);
          if (!call) return;
          pending.delete(id);
          reject(new DOMException("Aborted", "AbortError"));
          worker.postMessage({ cancel: id });
        };
        pending.set(id, { resolve, reject, signal, abort });
        if (signal) {
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }
        worker.postMessage({ id, method, input }, transfer ?? []);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      rejectAll(new Error("Office worker closed"));
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    },
  };
}

export function serveRpc(handlers) {
  const controllers = new Map();
  let queue = Promise.resolve();

  const run = async (request) => {
    const handler = handlers[request.method];
    if (!handler) {
      self.postMessage({
        id: request.id,
        ok: false,
        error: `Unknown method ${request.method}`,
      });
      return;
    }
    const controller = new AbortController();
    controllers.set(request.id, controller);
    try {
      const result = await handler(request.input, controller.signal);
      if (controller.signal.aborted) return;
      if (result instanceof Transfer) {
        self.postMessage(
          { id: request.id, ok: true, value: result.value },
          result.transfer,
        );
      } else {
        self.postMessage({ id: request.id, ok: true, value: result });
      }
    } catch (error) {
      self.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      controllers.delete(request.id);
    }
  };

  self.onmessage = (event) => {
    const data = event.data;
    if (data && "cancel" in data) {
      controllers.get(data.cancel)?.abort();
      return;
    }
    queue = queue.then(() => run(data)).catch(() => {});
  };
}
