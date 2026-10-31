/**
 * A stand-in for Ollama's HTTP API used by tests. It keeps an in-memory model list, streams
 * download progress, and answers /api/chat with a scripted coding agent: given the FastAPI demo
 * fixture and a request mentioning "/health", it explores, edits, adds a test, runs pytest and
 * summarises, exactly like a real model would through tool calls.
 */

interface WireMessage {
  role: string;
  content: string;
  tool_calls?: unknown[];
  tool_name?: string;
}

const enc = new TextEncoder();
const line = (o: unknown) => enc.encode(`${JSON.stringify(o)}\n`);

type Step =
  | { say: string; tool: string; args: Record<string, unknown> }
  | { final: (lastTool: string) => string };

const HEALTH_SCRIPT: Step[] = [
  { say: "Let me look at the project first.", tool: "list_dir", args: { path: ".", depth: 2 } },
  { say: "", tool: "read_file", args: { path: "app/main.py" } },
  { say: "", tool: "read_file", args: { path: "tests/test_main.py" } },
  {
    say: "I'll add the endpoint next to the existing routes.",
    tool: "edit_file",
    args: {
      path: "app/main.py",
      edits: [
        {
          search: '@app.get("/items/{item_id}")',
          replace:
            '@app.get("/health")\ndef health():\n    return {"status": "ok"}\n\n\n@app.get("/items/{item_id}")',
        },
      ],
    },
  },
  {
    say: "Now a test for it.",
    tool: "edit_file",
    args: {
      path: "tests/test_main.py",
      edits: [
        {
          search: "def test_root():",
          replace:
            'def test_health():\n    response = client.get("/health")\n    assert response.status_code == 200\n    assert response.json() == {"status": "ok"}\n\n\ndef test_root():',
        },
      ],
    },
  },
  { say: "Running the tests.", tool: "run_command", args: { command: "python -m pytest -q" } },
  {
    final: (last) =>
      /\b2 passed\b/.test(last) && !/failed/.test(last)
        ? 'Added a `GET /health` endpoint in `app/main.py` that returns `{"status": "ok"}`, and a test for it in `tests/test_main.py`. All tests pass (2 passed).'
        : `The tests did not pass:\n${last.slice(-500)}`,
  },
];

function scriptedChat(messages: WireMessage[]): Response {
  const firstUser = messages.find((m) => m.role === "user")?.content ?? "";
  const toolMsgs = messages.filter((m) => m.role === "tool");
  const words = (s: string) => s.split(/(?<= )/).filter(Boolean);
  const body = new ReadableStream({
    async start(ctl) {
      const finish = (n: number) =>
        ctl.enqueue(
          line({
            done: true,
            done_reason: "stop",
            prompt_eval_count: 900,
            eval_count: n,
            eval_duration: 5e8,
          }),
        );
      if (/broken tool call/.test(firstUser)) {
        // Like Qwen3-Coder on Ollama: a malformed tool call ends the stream with a parse error,
        // until the agent tells the model its reply could not be read.
        const nudged = messages.some((m) => m.role === "user" && m.content.includes("could not be read"));
        if (!nudged) {
          ctl.enqueue(line({ error: "XML syntax error on line 43: unexpected EOF" }));
        } else {
          ctl.enqueue(
            line({ message: { role: "assistant", content: "Recovered after a broken tool call." } }),
          );
          finish(6);
        }
        ctl.close();
        return;
      }
      if (!/\/health/.test(firstUser)) {
        for (const w of words("I can only run the scripted /health demo in this test model.")) {
          ctl.enqueue(line({ message: { role: "assistant", content: w } }));
        }
        finish(12);
        ctl.close();
        return;
      }
      const step = HEALTH_SCRIPT[Math.min(toolMsgs.length, HEALTH_SCRIPT.length - 1)] as Step;
      if ("final" in step) {
        for (const w of words(step.final(toolMsgs.at(-1)?.content ?? ""))) {
          ctl.enqueue(line({ message: { role: "assistant", content: w } }));
          await Bun.sleep(3);
        }
        finish(40);
      } else {
        for (const w of words(step.say)) {
          ctl.enqueue(line({ message: { role: "assistant", content: w } }));
          await Bun.sleep(3);
        }
        ctl.enqueue(
          line({
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ function: { name: step.tool, arguments: step.args } }],
            },
          }),
        );
        finish(30);
      }
      ctl.close();
    },
  });
  return new Response(body);
}

export function startFakeOllama(port = 0): {
  url: string;
  port: number;
  models: Map<string, number>;
  stop: () => void;
} {
  const models = new Map<string, number>([["qwen2.5-coder:1.5b", 986_000_000]]);
  const server = Bun.serve({
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
                  ctl.enqueue(line({ status: "downloading", total, completed: (total / 10) * i }));
                  await Bun.sleep(150);
                }
                models.set(model, total);
                ctl.enqueue(line({ status: "success" }));
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
          const body = (await req.json()) as { messages: WireMessage[]; tools?: unknown[] };
          if (body.tools?.length) return scriptedChat(body.messages);
          // Benchmarks and plain chats: a short streamed answer.
          const words = "def merge_intervals(intervals):\n    return sorted(intervals)\n".split(/(?<= )/);
          return new Response(
            new ReadableStream({
              async start(ctl) {
                for (const w of words) {
                  ctl.enqueue(line({ message: { content: w } }));
                  await Bun.sleep(5);
                }
                ctl.enqueue(line({ done: true, prompt_eval_count: 30, eval_count: 50, eval_duration: 1e9 }));
                ctl.close();
              },
            }),
          );
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port ?? port,
    models,
    stop: () => server.stop(true),
  };
}
