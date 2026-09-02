import { auditPublicPage } from "./lib/audit-core.mjs";

const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export default async (request) => {
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed." }), { status: 405, headers: { ...headers, allow: "POST" } });
  try {
    const body = await request.json();
    const result = await auditPublicPage(body?.url);
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch (error) {
    return new Response(JSON.stringify({ status: "error", error: error instanceof Error ? error.message : "Audit failed." }), { status: 400, headers });
  }
};
