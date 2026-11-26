import { LuaFactory } from "wasmoon";

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
    __atom_handler_keys[handler] = key
    return function()
      local u = __atom_unsubs[key]
      if u then u() end
      __atom_unsubs[key] = nil
      __atom_callbacks[key] = nil
      __atom_handler_keys[handler] = nil
    end
  end
  return __js_api.on(event, handler)
end

function pi.off(event, handler)
  local key = __atom_handler_keys[handler]
  if key then
    local u = __atom_unsubs[key]
    if u then u() end
    __atom_unsubs[key] = nil
    __atom_callbacks[key] = nil
    __atom_handler_keys[handler] = nil
    return
  end
  return __js_api.off(event, handler)
end

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

export interface LuaRuntime {
  engine: any;
  runSource(source: string): Promise<void>;
  runCallback(key: string, args: unknown[], timeoutMs: number): Promise<unknown>;
  close(): void;
}

export async function createLuaRuntime(): Promise<LuaRuntime> {
  const factory = new LuaFactory();
  const engine = await factory.createEngine({
    openStandardLibs: true,
    enableProxy: true,
  });
  await engine.doString(
    "__atom_callbacks = __atom_callbacks or {}\n" +
      "__atom_unsubs = __atom_unsubs or {}\n" +
      "__atom_handler_keys = __atom_handler_keys or {}\n" +
      "__atom_counter = 0\n",
  );

  const runtime: LuaRuntime = {
    engine,
    async runSource(source: string) {
      await engine.doString(
        "if package then package.path = '' ; package.cpath = '' end\n",
      );
      await engine.doString(PREAMBLE);
      await engine.doString(
        "debug.sethook(function()\n" +
          "  __atom_counter = (__atom_counter or 0) + 1\n" +
          "  if __atom_counter > 100000 then error('lua execution exceeded instruction budget') end\n" +
          "end, 'c', 1000)\n" +
          source +
          "\ndebug.sethook()\n",
      );
      await engine.doString(POSTAMBLE);
    },
    async runCallback(key: string, args: unknown[], timeoutMs: number) {
      const thread = engine.global.newThread();
      const code =
        "local __all = {...}\n" +
        "__atom_counter = 0\n" +
        "debug.sethook(function()\n" +
        "  __atom_counter = __atom_counter + 1\n" +
        "  if __atom_counter > 100000 then error(\"lua execution exceeded instruction budget\") end\n" +
        "end, \"c\", 1000)\n" +
        "local __ok, __res = pcall(function()\n" +
        "  local k = __all[1]\n" +
        "  local fn = __atom_callbacks[k]\n" +
        "  if type(fn) ~= \"function\" then return nil end\n" +
        "  return fn(table.unpack(__all, 2))\n" +
        "end)\n" +
        "debug.sethook()\n" +
        "if not __ok then error(__res) end\n" +
        "return __res\n";
      try {
        thread.loadString(code, "run");
        thread.pushValue(key);
        for (const arg of args) thread.pushValue(arg);
        const result = await thread.run(1 + args.length, {
          timeout: timeoutMs,
        });
        if (result && typeof result === "object" && "length" in result) {
          const arr = result as { length: number; [i: number]: unknown };
          return arr.length > 0 ? arr[0] : undefined;
        }
        return result;
      } finally {
        try {
          thread.close();
        } catch {
          // Closing an already-closed thread is harmless.
        }
      }
    },
    close() {
      // Best-effort cleanup; wasmoon engines have no explicit close.
    },
  };
  return runtime;
}
