function compactResult(result) {
  return {
    status: result.status,
    target_url: result.target_url,
    scores: result.scores,
    actions: result.actions,
    evidence: result.evidence,
    audit_scope: result.audit_scope,
  };
}

export async function registerAuditTool(runAudit, setStatus) {
  const context = document.modelContext;
  if (!context || typeof context.registerTool !== "function") {
    setStatus("unavailable", "This browser does not expose WebMCP. The audit UI still works, but no agent tool is active.");
    return false;
  }
  try {
    await context.registerTool({
      name: "agentready.run_audit",
      title: "Run an AgentReady public-page audit",
      description: "Audit one public HTTP or HTTPS HTML page for observable technical visibility, understanding, and buyability signals. Returns evidence, priority actions, and explicitly marks unobserved facts as unknown. It does not submit forms, execute remote JavaScript, or measure external AI rankings.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", format: "uri", description: "Absolute public http or https URL to audit." },
        },
        required: ["url"],
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute({ url }) {
        const result = await runAudit(url);
        return {
          content: [{ type: "text", text: JSON.stringify(compactResult(result)) }],
          structuredContent: compactResult(result),
        };
      },
    });
    setStatus("active", "WebMCP is active: agents can call agentready.run_audit with a public URL.");
    return true;
  } catch (error) {
    setStatus("unavailable", `WebMCP is exposed by this browser but tool registration failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return false;
  }
}
