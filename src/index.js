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

      if (path === "/api/projects" && method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT id, title, category, description, link, created_at, (image != '') AS has_image FROM projects ORDER BY id DESC"
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
        const image = String(b.image || "");
        if (image) {
          if (image.length > 800000) return json({ error: "Image trop lourde" }, 400);
          if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) {
            return json({ error: "Image invalide" }, 400);
          }
        }
        const r = await env.DB.prepare(
          "INSERT INTO projects (title, category, description, link, image) VALUES (?, ?, ?, ?, ?)"
        )
          .bind(title, category, description, link, image)
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
