export const PATH_MIME = "application/x-atom-lite-path";

const treePaths = new WeakMap();

function knownPaths(deps) {
  let workspaces = treePaths.get(deps);
  if (!workspaces) {
    workspaces = new Map();
    treePaths.set(deps, workspaces);
  }
  const workspace = deps.getWorkspace();
  let paths = workspaces.get(workspace);
  if (!paths) {
    paths = new Map();
    workspaces.set(workspace, paths);
  }
  return paths;
}

export function recordWorkspacePath(deps, path, info) {
  knownPaths(deps).set(path, info);
}

export function workspacePathKind(deps, path) {
  return knownPaths(deps).get(path)?.type ?? null;
}

export function workspacePathSize(deps, path) {
  return knownPaths(deps).get(path)?.size;
}

export function parsePathPayload(raw) {
  if (typeof raw !== "string" || !raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const result = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") return [];
    const { path, type } = item;
    if (typeof path !== "string" || !path) return [];
    if (type !== "file" && type !== "dir") return [];
    result.push({ path, type });
  }
  return result;
}

export function parsePlainPathData(text) {
  if (typeof text !== "string" || !text.startsWith("file:")) return null;
  const path = text.slice("file:".length);
  return path ? { path } : null;
}

export function hasWorkspaceDrag(dataTransfer) {
  return Boolean(dataTransfer?.types?.includes?.(PATH_MIME));
}

export function readWorkspaceDrag(dataTransfer, deps) {
  const payloads = parsePathPayload(dataTransfer?.getData?.(PATH_MIME) ?? "");
  const matched = payloads.filter(
    ({ path, type }) => workspacePathKind(deps, path) === type,
  );
  if (matched.length > 0) return matched;
  const plain = parsePlainPathData(dataTransfer?.getData?.("text/plain") ?? "");
  if (!plain) return [];
  const type = workspacePathKind(deps, plain.path);
  return type ? [{ path: plain.path, type }] : [];
}

export function startPathDrag(event, row, entry) {
  const { dataTransfer } = event;
  if (!dataTransfer) return;
  dataTransfer.setData(
    PATH_MIME,
    JSON.stringify({ path: entry.path, type: entry.type }),
  );
  dataTransfer.setData("text/plain", `file:${entry.path}`);
  dataTransfer.effectAllowed = "copy";
  const image = row.cloneNode(true);
  image.className = "files-row files-row-drag-image";
  image.style.width = `${row.getBoundingClientRect().width}px`;
  document.body.append(image);
  dataTransfer.setDragImage(image, 12, 12);
  setTimeout(() => image.remove(), 0);
}
