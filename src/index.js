const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

function isAdmin(request, env) {
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const pass = env.ADMIN_PASSWORD || "";
  if (!pass || token.length !== pass.length) return false;
  let diff = 0;
  for (let i = 0; i < pass.length; i++) {
    diff |= token.charCodeAt(i) ^ pass.charCodeAt(i);
  }
  return diff === 0;
}

const CATS = ["Affiche", "Vidéo", "Ebook", "Autre"];
const TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};
const MAX = 95 * 1024 * 1024;
const KEY_RE = /^[a-f0-9-]{36}\.[a-z0-9]{2,4}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === "/api/login" && method === "POST") {
        return isAdmin(request, env)
          ? json({ ok: true })
          : json({ error: "Mot de passe incorrect" }, 401);
      }

      if (path === "/api/upload" && method === "POST") {
        if (!isAdmin(request, env)) return json({ error: "Non autorisé" }, 401);
        const type = (request.headers.get("Content-Type") || "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        const ext = TYPES[type];
        if (!ext) return json({ error: "Type de fichier non accepté" }, 415);
        const len = Number(request.headers.get("Content-Length") || 0);
        if (!len) return json({ error: "Fichier vide ou taille inconnue" }, 411);
        if (len > MAX) return json({ error: "Fichier trop lourd (max 95 Mo)" }, 413);
        const key = crypto.randomUUID() + "." + ext;
        await env.FILES.put(key, request.body, {
          httpMetadata: { contentType: type },
        });
        return json({ ok: true, key, type });
      }

      const fm = path.match(/^\/api\/files\/([a-f0-9-]{36}\.[a-z0-9]{2,4})$/);
      if (fm && method === "GET") {
        const ranged = request.headers.has("Range");
        const obj = await env.FILES.get(fm[1], ranged ? { range: request.headers } : {});
        if (!obj) return new Response("Introuvable", { status: 404 });
        const h = new Headers();
        obj.writeHttpMetadata(h);
        h.set("ETag", obj.httpEtag);
        h.set("Accept-Ranges", "bytes");
        h.set("Cache-Control", "public, max-age=86400");
        h.set("X-Content-Type-Options", "nosniff");
        let status = 200;
        if (ranged && obj.range) {
          const r = obj.range;
          const size = obj.size;
          const start = r.suffix !== undefined ? size - r.suffix : r.offset || 0;
          const end =
            r.suffix !== undefined
              ? size - 1
              : r.length !== undefined
              ? start + r.length - 1
              : size - 1;
          h.set("Content-Range", "bytes " + start + "-" + end + "/" + size);
          h.set("Content-Length", String(end - start + 1));
          status = 206;
        }
        return new Response(obj.body, { status, headers: h });
      }

      if (path === "/api/projects" && method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT id, title, category, description, link, file_key, file_type, file_name, created_at, (image != '') AS has_image FROM projects ORDER BY id DESC"
        ).all();
        return json(results);
      }

      if (path === "/api/projects" && method === "POST") {
        if (!isAdmin(request, env)) return json({ error: "Non autorisé" }, 401);
        const b = await request.json();
        const title = String(b.title || "").trim().slice(0, 120);
        if (!title) return json({ error: "Le titre est obligatoire" }, 400);
        const category = CATS.includes(b.category) ? b.category : "Autre";
        const description = String(b.description || "").trim().slice(0, 600);
        const link = String(b.link || "").trim().slice(0, 500);
        if (link && !/^https?:\/\//i.test(link)) {
          return json({ error: "Le lien doit commencer par http:// ou https://" }, 400);
        }
        let fileKey = "";
        let fileType = "";
        const fileName = String(b.file_name || "").trim().slice(0, 150);
        if (b.file_key) {
          fileKey = String(b.file_key);
          if (!KEY_RE.test(fileKey)) return json({ error: "Fichier invalide" }, 400);
          const head = await env.FILES.head(fileKey);
          if (!head) return json({ error: "Fichier introuvable" }, 400);
          fileType = (head.httpMetadata && head.httpMetadata.contentType) || "";
        }
        const r = await env.DB.prepare(
          "INSERT INTO projects (title, category, description, link, file_key, file_type, file_name) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
          .bind(title, category, description, link, fileKey, fileType, fileName)
          .run();
        return json({ ok: true, id: r.meta.last_row_id }, 201);
      }

      const m = path.match(/^\/api\/projects\/(\d+)(\/image)?$/);
      if (m) {
        const id = Number(m[1]);

        if (m[2] && method === "GET") {
          const row = await env.DB.prepare("SELECT image FROM projects WHERE id = ?")
            .bind(id)
            .first();
          if (!row || !row.image) return new Response("Introuvable", { status: 404 });
          const img = row.image;
          const mime = img.slice(5, img.indexOf(";"));
          const bin = atob(img.slice(img.indexOf(",") + 1));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new Response(bytes, {
            headers: {
              "Content-Type": mime,
              "Cache-Control": "public, max-age=86400",
            },
          });
        }

        if (!m[2] && method === "DELETE") {
          if (!isAdmin(request, env)) return json({ error: "Non autorisé" }, 401);
          const row = await env.DB.prepare("SELECT file_key FROM projects WHERE id = ?")
            .bind(id)
            .first();
          if (row && row.file_key) await env.FILES.delete(row.file_key);
          await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
          return json({ ok: true });
        }
      }

      if (path.startsWith("/api/")) return json({ error: "Introuvable" }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: "Erreur serveur" }, 500);
    }
  },
};
