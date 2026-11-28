const LANGUAGES = {
  c: "c",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  diff: "diff",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "xml",
  htm: "xml",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  lua: "lua",
  mjs: "javascript",
  md: "markdown",
  patch: "diff",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  svg: "xml",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  txt: "plaintext",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

const OFFICE_MIME_KINDS = new Map([
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "document",
  ],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "spreadsheet",
  ],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "presentation",
  ],
]);
const OFFICE_EXTENSION_KINDS = new Map([
  [".docx", "document"],
  [".xlsx", "spreadsheet"],
  [".pptx", "presentation"],
]);

export const FILE_KINDS = {
  text: { label: "Text", probe: { route: "file" } },
  image: { label: "Image", probe: { route: "file" } },
  video: {
    label: "Video",
    probe: { route: "media", headers: { Range: "bytes=0-0" } },
  },
  audio: {
    label: "Audio",
    probe: { route: "media", headers: { Range: "bytes=0-0" } },
  },
  markdown: { label: "Markdown", probe: { route: "file" } },
  pdf: { label: "PDF", probe: { route: "file" } },
  document: { label: "Word document", probe: { route: "download" } },
  spreadsheet: { label: "Spreadsheet", probe: { route: "download" } },
  presentation: { label: "Presentation", probe: { route: "download" } },
  none: { label: "Unsupported file", probe: { route: "download" } },
};

export function languageForPath(path) {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  return LANGUAGES[extension] ?? null;
}

function isTextFile(path, contentType) {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("text/")) return true;
  if (/(json|xml|yaml|javascript|typescript|x-sh)/.test(type)) return true;
  return (
    languageForPath(path) !== null ||
    /\.(env|ini|cfg|conf|properties|editorconfig|lock)$/i.test(path)
  );
}

export function fileKind(path, contentType = "") {
  const type = contentType.split(";")[0].trim().toLowerCase();
  const extension = path.toLowerCase().split(".").pop();
  const ext = path.toLowerCase().includes(".") ? `.${extension}` : "";
  if (type === "application/pdf" || ext === ".pdf") return "pdf";
  if (
    type.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path)
  )
    return "image";
  if (
    type.startsWith("video/") ||
    /\.(mp4|webm|mov|mkv|avi|mpeg|mpg|ogv)$/i.test(path)
  )
    return "video";
  if (
    type.startsWith("audio/") ||
    /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|weba)$/i.test(path)
  )
    return "audio";
  if (
    type === "text/markdown" ||
    ext === ".md" ||
    ext === ".markdown" ||
    ext === ".mdx"
  )
    return "markdown";
  const office = OFFICE_MIME_KINDS.get(type) ?? OFFICE_EXTENSION_KINDS.get(ext);
  if (office) return office;
  return isTextFile(path, type) ? "text" : "none";
}

export function kindLabel(kind, path) {
  const label = FILE_KINDS[kind]?.label;
  if (label) return label;
  const extension = path.toLowerCase().split(".").pop() ?? "";
  return extension ? `${extension.toUpperCase()} file` : "Unknown file";
}
