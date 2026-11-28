import { element, icon } from "./dom.js";
import { downloadUrl } from "./file-urls.js";

export function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let scaled = value / 1024;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled.toFixed(1)} ${units[index]}`;
}

export function noPreviewCard({
  name,
  size,
  detail,
  kind,
  path,
  token,
  onCopy,
}) {
  const box = element("div", "files-no-preview");
  box.append(icon("file", "icon files-state-icon"));
  box.append(element("p", "files-state-title", `No preview for ${name}`));
  if (kind) box.append(element("p", "files-state-kind", kind));
  box.append(
    element(
      "p",
      "files-state-detail",
      detail || "This file type is not supported.",
    ),
  );
  if (size != null)
    box.append(element("p", "files-state-meta", formatSize(size)));
  if (path != null) {
    const actions = element("div", "files-state-actions");
    const download = element("a", "files-action");
    download.href = downloadUrl(path, token ?? "");
    download.download = name;
    download.setAttribute("aria-label", `Download ${name}`);
    download.append(icon("download", "icon"), element("span", "", "Download"));
    const copy = element("button", "files-action");
    copy.type = "button";
    copy.setAttribute("aria-label", `Copy path to ${name}`);
    copy.append(icon("copy", "icon"), element("span", "", "Copy path"));
    copy.addEventListener("click", () => void onCopy?.());
    actions.append(download, copy);
    box.append(actions);
  }
  return box;
}
