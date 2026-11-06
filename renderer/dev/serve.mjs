import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const rootDir = process.argv[2];
const port = Number(process.argv[3] || 8791);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};
http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  let rel = u === "/" ? "/dev/smoke.html" : u;
  let p = path.normalize(path.join(rootDir, rel));
  const isFile = (f) => fs.existsSync(f) && fs.statSync(f).isFile();
  if (!isFile(p)) {
    // 回退：如果请求形如 /dev/src/...，去掉 dev 前缀
    const alt = path.normalize(path.join(rootDir, rel.replace(/^\/dev\//, "/")));
    if (isFile(alt)) { p = alt; }
  }
  if (!isFile(p)) { console.log("404 " + u); res.writeHead(404); return res.end("404 " + u); }

  const type = MIME[path.extname(p)] || "application/octet-stream";
  const total = fs.statSync(p).size;
  const range = req.headers.range;

  // 支持 Range：没有它，浏览器连音频都拖不动（seekable 为空，改 currentTime 会被丢掉）
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : total - Number(m[2]);
      let end = m[1] && m[2] ? Number(m[2]) : total - 1;
      start = Math.max(0, Math.min(start, total - 1));
      end = Math.max(start, Math.min(end, total - 1));
      console.log("206 " + u + " " + start + "-" + end + "/" + total);
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Accept-Ranges": "bytes",
      });
      return fs.createReadStream(p, { start, end }).pipe(res);
    }
    console.log("416 " + u);
    res.writeHead(416, { "Content-Range": `bytes */${total}` });
    return res.end();
  }

  console.log("200 " + u);
  res.writeHead(200, { "Content-Type": type, "Content-Length": total, "Accept-Ranges": "bytes" });
  fs.createReadStream(p).pipe(res);
}).listen(port, "127.0.0.1", () => console.log("serving on " + port));
