import { readFileSync } from "node:fs";
import { LuaFactory, LuaTimeoutError, type LuaEngine } from "wasmoon";
import type { ExtensionAPI } from "./api.js";
import type {
  ExtensionModule,
  ExtensionModuleRuntime,
} from "./module-runtime.js";
import type { AtomEvent, ExtensionCommand, ExtensionTool } from "./types.js";

const INIT = `
__atom_callbacks = {}
__atom_unsubs = {}
__atom_handler_keys = {}
__atom_counter = 0
`;

const PREAMBLE = `
function __atom_new_key()
  __atom_counter = __atom_counter + 1
  return "cb_" .. tostring(__atom_counter)
end

local pi = {}
setmetatable(pi, { __index = function(_, k) return __js_api[k] end })

function pi.registerTool(tool)
  if type(tool) == "table" and type(tool.execute) == "function" then
    local key = __atom_new_key()
    __atom_callbacks[key] = tool.execute
    tool.execute = nil
    tool.__executeKey = key
  end
  return __js_registerTool(tool)
end

function pi.registerCommand(cmd)
  if type(cmd) == "table" then
    if type(cmd.run) == "function" then
      local key = __atom_new_key()
      __atom_callbacks[key] = cmd.run
      cmd.run = nil
      cmd.__runKey = key
    end
    if type(cmd.handler) == "function" then
      local key = __atom_new_key()
      __atom_callbacks[key] = cmd.handler
      cmd.handler = nil
      cmd.__handlerKey = key
    end
  end
  return __js_registerCommand(cmd)
end

function pi.on(event, handler)
  if type(handler) == "function" then
    local key = __atom_new_key()
    __atom_callbacks[key] = handler
    local unsub = __js_on(event, key)
    __atom_unsubs[key] = unsub
    local byEvent = __atom_handler_keys[handler]
    if not byEvent then
      byEvent = {}
      __atom_handler_keys[handler] = byEvent
    end
    byEvent[event] = key
    return function()
      local u = __atom_unsubs[key]
      if u then u() end
      __atom_unsubs[key] = nil
      __atom_callbacks[key] = nil
      if byEvent[event] == key then byEvent[event] = nil end
    end
  end
  return __js_api.on(event, handler)
end

function pi.off(event, handler)
  local byEvent = __atom_handler_keys[handler]
  local key = byEvent and byEvent[event]
  if key then
    local u = __atom_unsubs[key]
    if u then u() end
    __atom_unsubs[key] = nil
    __atom_callbacks[key] = nil
    byEvent[event] = nil
    return
  end
  return __js_api.off(event, handler)
end

pi.ui = setmetatable({}, { __index = function(_, k) return __js_api.ui[k] end })

local __atom_async_methods = {"exec", "fetch", "select", "confirm", "input", "span"}
for _, __name in ipairs(__atom_async_methods) do
  pi[__name] = function(...)
    return __js_api[__name](...):await()
  end
end
local __atom_ui_async = {"select", "confirm", "input", "editor", "custom"}
for _, __name in ipairs(__atom_ui_async) do
  pi.ui[__name] = function(...)
    return __js_api.ui[__name](...):await()
  end
end

function pi.wrapTool(name, handler)
  if type(handler) == "function" then
    local key = __atom_new_key()
    __atom_callbacks[key] = handler
    return __js_wrapTool(name, key)
  end
  return __js_api.wrapTool(name, handler)
end

_G.pi = pi
`;

const POSTAMBLE = `
if type(activate) == "function" then
  local orig = activate
  local function wrapped()
    return orig(_G.pi)
  end
  local key = __atom_new_key()
  __atom_callbacks[key] = wrapped
  __atom_activate_key = key
end
if type(test) == "function" then
  local key = __atom_new_key()
  __atom_callbacks[key] = test
  __atom_test_key = key
end
`;

const CALLBACK = `
local __all = {...}
local __ok, __res = pcall(function()
  local fn = __atom_callbacks[__all[1]]
  if type(fn) ~= "function" then return nil end
  return fn(table.unpack(__all, 2))
end)
if not __ok then error(__res) end
return __res
`;

async function runChunk(
  engine: LuaEngine,
  code: string,
  timeoutMs: number,
): Promise<void> {
  const thread = engine.global.newThread();
  try {
    thread.loadString(code, "lua-extension");
    await thread.run(0, { timeout: timeoutMs });
  } finally {
    thread.close();
  }
}

async function runCallback(
  engine: LuaEngine,
  key: string,
  args: unknown[],
  timeoutMs: number,
): Promise<unknown> {
  const thread = engine.global.newThread();
  try {
    thread.loadString(CALLBACK, "lua-callback");
    thread.pushValue(key);
    for (const arg of args) thread.pushValue(arg);
    const result = await thread.run(1 + args.length, { timeout: timeoutMs });
    return result.length > 0 ? result[0] : undefined;
  } catch (error) {
    if (
      error instanceof LuaTimeoutError ||
      (error instanceof Error &&
        error.message.includes("thread timeout exceeded"))
    ) {
      throw new Error("handler timed out");
    }
    throw error;
  } finally {
    thread.close();
  }
}

function disposeEngine(engine: LuaEngine): void {
  for (const key of [
    "__js_api",
    "__js_registerTool",
    "__js_registerCommand",
    "__js_on",
    "__js_wrapTool",
  ]) {
    engine.global.set(key, undefined);
  }
}

function bindApi(
  engine: LuaEngine,
  api: ExtensionAPI,
  timeoutMs: number,
): void {
  engine.global.set("__js_api", api);
  engine.global.set("__js_registerTool", (tool: ExtensionTool) => {
    const key = (tool as unknown as Record<string, unknown>).__executeKey;
    if (typeof key === "string") {
      delete (tool as unknown as Record<string, unknown>).__executeKey;
      tool.execute = (...args: unknown[]) =>
        runCallback(engine, key, args, timeoutMs);
    }
    api.registerTool(tool);
  });
  engine.global.set("__js_registerCommand", (command: ExtensionCommand) => {
    const candidate = command as unknown as Record<string, unknown>;
    for (const field of ["__runKey", "__handlerKey"] as const) {
      const key = candidate[field];
      if (typeof key !== "string") continue;
      delete candidate[field];
      const method = field === "__runKey" ? "run" : "handler";
      command[method] = async (...args: unknown[]) => {
        await runCallback(engine, key, args, timeoutMs);
      };
    }
    api.registerCommand(command);
  });
  engine.global.set("__js_on", (event: AtomEvent, key: string) =>
    api.on(event, (payload, ctx) =>
      runCallback(engine, key, [payload, ctx], timeoutMs),
    ),
  );
  engine.global.set("__js_wrapTool", (name: string, key: string) =>
    api.wrapTool(name, (call, next) =>
      runCallback(engine, key, [call, next], timeoutMs),
    ),
  );
}

export function createLuaModuleRuntime(
  timeoutMs: number,
): ExtensionModuleRuntime {
  return {
    async load(entryPath: string): Promise<ExtensionModule> {
      const source = readFileSync(entryPath, "utf8");
      const engine = await new LuaFactory().createEngine({
        openStandardLibs: true,
        enableProxy: true,
      });
      try {
        await runChunk(
          engine,
          INIT + "if package then package.path = '' ; package.cpath = '' end\n",
          timeoutMs,
        );
        await runChunk(engine, PREAMBLE, timeoutMs);
        await runChunk(engine, source, timeoutMs);
        await runChunk(engine, POSTAMBLE, timeoutMs);

        const activateKey = engine.global.get("__atom_activate_key");
        if (typeof activateKey !== "string") {
          throw new Error("extension must export an activate function");
        }
        const testKey = engine.global.get("__atom_test_key");
        const exports: Record<string, unknown> = {};
        if (typeof testKey === "string") {
          exports.test = (ctx: unknown) =>
            runCallback(engine, testKey, [ctx], timeoutMs);
        }
        return {
          factory: () => runCallback(engine, activateKey, [], timeoutMs),
          exports,
          bind: (api) => bindApi(engine, api, timeoutMs),
          dispose: () => disposeEngine(engine),
        };
      } catch (error) {
        disposeEngine(engine);
        throw error;
      }
    },
  };
}
