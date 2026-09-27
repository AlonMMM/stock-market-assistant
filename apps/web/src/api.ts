export const number = (n: number) => n.toLocaleString("en-US");

// Reads a JSON API response. Cloudflare answers some failures (such as a
// Worker exceeding its CPU limit) with an HTML page instead of our JSON.
export async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      response.status === 503 ||
        response.status >= 520 ||
        /exceeded/i.test(text)
        ? `Server limit reached (HTTP ${response.status}). Try fewer symbols or a shorter range.`
        : `Unexpected server response (HTTP ${response.status})`,
    );
  }
  if (!response.ok)
    throw new Error(
      (payload as { error?: string })?.error ??
        `Request failed (HTTP ${response.status})`,
    );
  return payload as T;
}
