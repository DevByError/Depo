/**
 * A tiny stand-in for Ollama's HTTP API, used by end-to-end tests. Holds an in-memory model
 * list; pulls stream progress over ~1.5 s and then add the model.
 */
const port = Number(process.env.FAKE_OLLAMA_PORT ?? 47211);
const models = new Map<string, number>([["qwen2.5-coder:1.5b", 986_000_000]]);
const enc = new TextEncoder();

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/":
        return new Response("Ollama is running");
      case "/api/version":
        return Response.json({ version: "0.0.0-fake" });
      case "/api/tags":
        return Response.json({
          models: [...models].map(([name, size]) => ({
            name,
            size,
            modified_at: new Date().toISOString(),
            details: { quantization_level: "Q4_K_M" },
          })),
        });
      case "/api/pull": {
        const { model } = (await req.json()) as { model: string };
        const total = 2_000_000_000;
        return new Response(
          new ReadableStream({
            async start(ctl) {
              for (let i = 0; i <= 10; i++) {
                ctl.enqueue(
                  enc.encode(
                    `${JSON.stringify({ status: "downloading", total, completed: (total / 10) * i })}\n`,
                  ),
                );
                await Bun.sleep(150);
              }
              models.set(model, total);
              ctl.enqueue(enc.encode(`${JSON.stringify({ status: "success" })}\n`));
              ctl.close();
            },
          }),
        );
      }
      case "/api/delete": {
        const { model } = (await req.json()) as { model: string };
        models.delete(model);
        return new Response(null);
      }
      case "/api/chat": {
        const words = "def merge_intervals(intervals):\n    return sorted(intervals)\n".split(/(?<= )/);
        return new Response(
          new ReadableStream({
            async start(ctl) {
              for (const w of words) {
                ctl.enqueue(enc.encode(`${JSON.stringify({ message: { content: w } })}\n`));
                await Bun.sleep(5);
              }
              ctl.enqueue(
                enc.encode(
                  `${JSON.stringify({ done: true, prompt_eval_count: 30, eval_count: 50, eval_duration: 1e9 })}\n`,
                ),
              );
              ctl.close();
            },
          }),
        );
      }
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`fake ollama on ${port}`);
