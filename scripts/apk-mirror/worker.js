// Fork: the Android APK of each fork release through Cloudflare's cache (kitshn.config.ts).
// Obtainium reads /index.html as an HTML source with the link filter `t3code-.*-android\.apk`.
// GitHub counts the Worker's calls against Cloudflare's shared addresses, so the public API often
// answers 403: the last good list stays 30 days, and a secret KITSHN_GITHUB_TOKEN lifts the limit.

const APK = /^t3code-.+-android\.apk$/;
const INDEX_TTL = 300;
const LIST_KEEP = 30 * 24 * 3600;

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("GET only", { status: 405 });
    const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
    try {
      if (name === "" || name === "index.html") return await index(env, ctx);
      if (name === "latest/t3code-android.apk" || name === "latest")
        return await latest(request, env, ctx);
      if (!APK.test(name)) return new Response("Not found", { status: 404 });
      return await apk(name, request, env, ctx);
    } catch (error) {
      if (!(error instanceof NoReleaseList)) throw error;
      return new Response(error.message, { status: 503, headers: { "retry-after": "300" } });
    }
  },
};

class NoReleaseList extends Error {}

/** The APK assets of the newest releases, newest first; the last good list when GitHub refuses. */
async function releases(env, ctx) {
  const key = new Request(`https://releases.invalid/${env.REPO}`);
  const kept = await caches.default.match(key).then((hit) => hit?.json());
  if (kept && Date.now() - kept.fetchedAt < INDEX_TTL * 1000) return kept.list;
  const response = await fetch(`https://api.github.com/repos/${env.REPO}/releases?per_page=30`, {
    headers: {
      "user-agent": "t3-apk-mirror",
      accept: "application/vnd.github+json",
      ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!response.ok) {
    if (kept) return kept.list;
    throw new NoReleaseList(`GitHub releases ${response.status} and no list kept yet`);
  }
  const list = (await response.json())
    .flatMap((release) =>
      release.assets
        .filter((asset) => APK.test(asset.name))
        .map((asset) => ({
          name: asset.name,
          size: asset.size,
          url: asset.browser_download_url,
          publishedAt: release.published_at,
        })),
    )
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  ctx.waitUntil(
    caches.default.put(
      key,
      new Response(JSON.stringify({ fetchedAt: Date.now(), list }), {
        headers: { "cache-control": `max-age=${LIST_KEEP}` },
      }),
    ),
  );
  return list;
}

async function index(env, ctx) {
  const rows = (await releases(env, ctx)).map(
    (asset) =>
      `<li><a href="/${asset.name}">${asset.name}</a> ${(asset.size / 1e6).toFixed(0)} MB ${asset.publishedAt}</li>`,
  );
  const html = `<!doctype html><meta charset="utf-8"><title>T3 Code fork Android builds</title><h1>T3 Code fork Android builds</h1><p><a href="/latest/t3code-android.apk">latest</a></p><ul>${rows.join("")}</ul>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": `max-age=${INDEX_TTL}`,
    },
  });
}

async function latest(request, env, ctx) {
  const [newest] = await releases(env, ctx);
  if (!newest) return new Response("No release", { status: 404 });
  return Response.redirect(new URL(`/${newest.name}`, request.url).toString(), 302);
}

async function apk(name, request, env, ctx) {
  // The stored copy has no range; the match carries the request's Range header so one copy
  // answers every range request with a 206.
  const key = new Request(new URL(`/${name}`, request.url).toString());
  const hit = await caches.default.match(new Request(key, { headers: request.headers }), {
    ignoreMethod: true,
  });
  if (hit) return hit;
  const asset = (await releases(env, ctx)).find((item) => item.name === name);
  if (!asset) return new Response("Not found", { status: 404 });
  const upstream = await fetch(asset.url, { headers: { "user-agent": "t3-apk-mirror" } });
  if (!upstream.ok || !upstream.body)
    return new Response(`GitHub ${upstream.status}`, { status: 502 });
  const response = new Response(upstream.body, {
    headers: {
      "content-type": "application/vnd.android.package-archive",
      "content-length": upstream.headers.get("content-length") ?? String(asset.size),
      "cache-control": "public, max-age=31536000, immutable",
      "accept-ranges": "bytes",
      // Cloudflare's cache answers Range requests only for a response with an ETag.
      etag: `"${name}"`,
    },
  });
  ctx.waitUntil(caches.default.put(key, response.clone()));
  return response;
}
