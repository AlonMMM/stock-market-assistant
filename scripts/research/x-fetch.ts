// Downloads one X account's posts with the official X API v2 (read-only, pay-per-use:
// every post returned is billed) and groups them into threads for study.
//
//   node --env-file=.env --import tsx scripts/research/x-fetch.ts <step> [--options]
//
// Steps:
//   count    posts per day from full-archive counts; run first to size the cost.
//   posts    full-archive search `from:<handle>` since --since, resumable, stops at --max.
//   ids      look up posts by id or URL listed in --file (one per line), e.g. highlights,
//            which the API has no endpoint for.
//   threads  offline: group the saved posts by conversation into threads.json / threads.md.
//   media    download the saved posts' images (and video previews) into <dir>/media; the
//            image CDN is not the API and is not billed.
//
// Options: --handle ultrawavetrader  --since 2023-10-09  --max 20000  --dir data/local/x/<handle>
//   --own true   only his posts and his own thread updates: no retweets, no replies to others.
// Credential: X_BEARER_TOKEN in the ignored .env. Output stays under data/local (outside
// Git): it is third-party content.
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";

const [step = "", ...rest] = process.argv.slice(2);
const args = new Map<string, string>();
for (let i = 0; i < rest.length; i += 2)
  args.set(rest[i]!.replace(/^--/, ""), rest[i + 1]!);
const handle = (args.get("handle") ?? "ultrawavetrader").replace(/^@/, "");
const since = args.get("since") ?? "2023-10-09";
const max = Number(args.get("max") ?? 20000);
const dir = args.get("dir") ?? `data/local/x/${handle}`;
// Replies to himself (thread updates) are `to:<handle>`; replies to others are dropped.
const query =
  args.get("own") === "true"
    ? `from:${handle} -is:retweet (-is:reply OR to:${handle})`
    : `from:${handle}`;
mkdirSync(`${dir}/raw`, { recursive: true });

const fields = new URLSearchParams({
  "tweet.fields":
    "created_at,conversation_id,referenced_tweets,in_reply_to_user_id,author_id,entities,attachments,note_tweet,public_metrics",
  expansions:
    "attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id",
  "media.fields": "type,url,preview_image_url,alt_text",
  "user.fields": "username",
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function get(path: string, query: URLSearchParams): Promise<any> {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) throw new Error("Set X_BEARER_TOKEN in .env");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.x.com/2${path}?${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 429 && attempt < 6) {
      const reset = Number(res.headers.get("x-rate-limit-reset") ?? 0) * 1000;
      await sleep(Math.max(reset - Date.now(), 15_000));
      continue;
    }
    if (!res.ok)
      throw new Error(
        `${res.status} ${path}: ${(await res.text()).slice(0, 300)}`,
      );
    await sleep(1100); // full-archive search allows 1 request per second
    return res.json();
  }
}
const startTime = `${since}T00:00:00Z`;

if (step === "count") {
  let total = 0;
  let next: string | undefined;
  do {
    const q = new URLSearchParams({
      query,
      start_time: startTime,
      granularity: "day",
    });
    if (next) q.set("next_token", next);
    const j = await get("/tweets/counts/all", q);
    total += j.meta?.total_tweet_count ?? 0;
    next = j.meta?.next_token;
  } while (next);
  console.log(
    JSON.stringify({
      handle,
      since,
      posts: total,
      estimatedUsd: +(total * 0.005).toFixed(2),
    }),
  );
} else if (step === "posts") {
  // Resumes from state.json; each page is saved as soon as it arrives.
  const statePath = `${dir}/state.json`;
  const state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : { page: 0, posts: 0, next: undefined as string | undefined, done: false };
  while (!state.done && state.posts < max) {
    const q = new URLSearchParams(fields);
    q.set("query", query);
    q.set("start_time", startTime);
    q.set(
      "max_results",
      String(Math.min(500, Math.max(10, max - state.posts))),
    );
    if (state.next) q.set("next_token", state.next);
    const j = await get("/tweets/search/all", q);
    state.page++;
    state.posts += j.data?.length ?? 0;
    writeFileSync(
      `${dir}/raw/search-${String(state.page).padStart(4, "0")}.json`,
      JSON.stringify(j),
    );
    state.next = j.meta?.next_token;
    state.done = !state.next;
    writeFileSync(statePath, JSON.stringify(state));
    console.log(
      JSON.stringify({
        page: state.page,
        posts: state.posts,
        oldest: j.data?.at(-1)?.created_at,
      }),
    );
  }
} else if (step === "ids") {
  const ids = readFileSync(args.get("file")!, "utf8")
    .split("\n")
    .map((l) => l.match(/(\d{8,})\s*$/)?.[1] ?? l.match(/status\/(\d+)/)?.[1])
    .filter((id): id is string => !!id);
  for (let i = 0; i < ids.length; i += 100) {
    const q = new URLSearchParams(fields);
    q.set("ids", ids.slice(i, i + 100).join(","));
    const j = await get("/tweets", q);
    writeFileSync(
      `${dir}/raw/ids-${String(i / 100 + 1).padStart(4, "0")}.json`,
      JSON.stringify(j),
    );
    console.log(
      JSON.stringify({
        requested: ids.slice(i, i + 100).length,
        got: j.data?.length ?? 0,
      }),
    );
  }
  writeFileSync(`${dir}/highlights.json`, JSON.stringify(ids));
} else if (step === "threads") {
  type Post = {
    id: string;
    created_at: string;
    conversation_id: string;
    author_id: string;
    text: string;
    note_tweet?: { text: string };
    referenced_tweets?: { type: string; id: string }[];
    attachments?: { media_keys?: string[] };
    public_metrics?: Record<string, number>;
  };
  const posts = new Map<string, Post>();
  const context = new Map<string, Post>();
  const media = new Map<
    string,
    { type: string; url?: string; preview_image_url?: string }
  >();
  for (const f of readdirSync(`${dir}/raw`).sort()) {
    const j = JSON.parse(readFileSync(`${dir}/raw/${f}`, "utf8"));
    for (const p of j.data ?? []) posts.set(p.id, p);
    for (const p of j.includes?.tweets ?? []) context.set(p.id, p);
    for (const m of j.includes?.media ?? []) media.set(m.media_key, m);
  }
  const highlights = new Set<string>(
    existsSync(`${dir}/highlights.json`)
      ? JSON.parse(readFileSync(`${dir}/highlights.json`, "utf8"))
      : [],
  );
  const own = [...posts.values()].filter(
    (p) => !p.referenced_tweets?.some((r) => r.type === "retweeted"),
  );
  const byConversation = new Map<string, Post[]>();
  for (const p of own)
    byConversation.set(p.conversation_id, [
      ...(byConversation.get(p.conversation_id) ?? []),
      p,
    ]);
  const threads = [...byConversation.entries()]
    .map(([conversation, list]) => {
      list.sort((a, b) => a.created_at.localeCompare(b.created_at));
      const root = posts.get(conversation) ?? context.get(conversation);
      return {
        conversation,
        start: list[0]!.created_at,
        highlight: list.some((p) => highlights.has(p.id)),
        // A reply to someone else's post keeps that post as context.
        replyTo:
          root && !posts.has(conversation)
            ? (root.note_tweet?.text ?? root.text)
            : undefined,
        posts: list.map((p) => ({
          id: p.id,
          time: p.created_at,
          text: p.note_tweet?.text ?? p.text,
          quoted: p.referenced_tweets
            ?.filter((r) => r.type === "quoted")
            .map((r) => context.get(r.id)?.text),
          media: (p.attachments?.media_keys ?? []).map(
            (k) => media.get(k)?.url ?? media.get(k)?.preview_image_url,
          ),
          metrics: p.public_metrics,
        })),
      };
    })
    .sort((a, b) => a.start.localeCompare(b.start));
  writeFileSync(`${dir}/threads.json`, JSON.stringify(threads, null, 1));
  const md = threads.map((t) =>
    [
      `## ${t.start}${t.highlight ? " · highlight" : ""} · https://x.com/${handle}/status/${t.conversation}`,
      t.replyTo ? `> reply to: ${t.replyTo.replace(/\n/g, " ")}` : "",
      ...t.posts.map(
        (p) =>
          `- ${p.time.slice(11, 16)}Z ${p.text}${p.media.length ? ` [${p.media.length} media]` : ""}`,
      ),
    ]
      .filter(Boolean)
      .join("\n"),
  );
  writeFileSync(`${dir}/threads.md`, md.join("\n\n"));
  console.log(
    JSON.stringify({
      posts: own.length,
      threads: threads.length,
      highlights: [...highlights].length,
    }),
  );
} else if (step === "media") {
  // Saves each image as <post id>-<n>.<ext> and lists them in media.json.
  mkdirSync(`${dir}/media`, { recursive: true });
  const saved: { post: string; file: string; type: string }[] = [];
  for (const f of readdirSync(`${dir}/raw`).sort()) {
    const j = JSON.parse(readFileSync(`${dir}/raw/${f}`, "utf8"));
    const media = new Map<string, any>(
      (j.includes?.media ?? []).map((m: any) => [m.media_key, m]),
    );
    for (const p of j.data ?? [])
      for (const [n, key] of (p.attachments?.media_keys ?? []).entries()) {
        const m = media.get(key);
        const url: string | undefined = m?.url ?? m?.preview_image_url;
        if (!url) continue;
        const file = `${p.id}-${n + 1}${url.match(/\.\w+$/)?.[0] ?? ".jpg"}`;
        if (!existsSync(`${dir}/media/${file}`)) {
          // `name=orig` is the full-resolution image.
          const res = await fetch(`${url}?name=orig`);
          if (!res.ok) {
            console.error(`${res.status} ${file}`);
            continue;
          }
          writeFileSync(
            `${dir}/media/${file}`,
            Buffer.from(await res.arrayBuffer()),
          );
        }
        saved.push({ post: p.id, file, type: m.type });
      }
  }
  writeFileSync(`${dir}/media.json`, JSON.stringify(saved, null, 1));
  console.log(JSON.stringify({ images: saved.length }));
} else {
  console.error(
    "Usage: x-fetch.ts count|posts|ids|threads|media [--handle h] [--since YYYY-MM-DD] [--max n] [--file f]",
  );
  process.exit(1);
}
