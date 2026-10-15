const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname);
const port = Number(process.env.PORT) || 8000;
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

http.createServer((request, response) => {
  let pathname;
  let requestUrl;
  try {
    requestUrl = new URL(request.url, "http://localhost");
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }

  if (pathname === "/select/worker-poc.html" || pathname === "/select/" || pathname === "/select/index.html") {
    response.writeHead(302, { Location: `/select${requestUrl.search}` });
    response.end();
    return;
  }

  const relativePath = pathname === "/"
    ? "index.html"
    : /^\/admin\/?$/.test(pathname)
      ? "select/admin.html"
      : pathname === "/select" && requestUrl.searchParams.has("project")
        ? "select/worker-poc.html"
        : pathname === "/select" || pathname === "/select/index.html"
          ? null
        : pathname.replace(/^\/+/, "");
  if (!relativePath) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  let filePath = path.resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (!statError && stats.isDirectory()) filePath = path.join(filePath, "index.html");

    fs.readFile(filePath, (error, content) => {
      if (error) {
        const notFound = error.code === "ENOENT" || error.code === "ENOTDIR";
        response.writeHead(notFound ? 404 : 500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(notFound ? "Not found" : "Server error");
        return;
      }

    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
    });
  });
}).listen(port, () => {
  console.log(`MR Digital Studio is running at http://localhost:${port}`);
});
