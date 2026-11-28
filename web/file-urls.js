function guardedUrl(route, path, token) {
  return `/${route}?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`;
}

export function mediaUrl(path, token) {
  return guardedUrl("media", path, token);
}

export function downloadUrl(path, token) {
  return guardedUrl("download", path, token);
}

export function imageUrl(path, token) {
  return guardedUrl("image", path, token);
}
