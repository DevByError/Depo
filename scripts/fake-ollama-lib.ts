/**
 * A stand-in for Ollama's HTTP API used by tests. It keeps an in-memory model list, streams
 * download progress, and answers /api/chat with a scripted coding agent: given the FastAPI demo
 * fixture and a request like "add a /health endpoint", it explores, edits, adds a test, runs pytest and
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

/** The scripted agent for "add a /<name> endpoint": explore, edit, add a test, run pytest, summarise. */
function endpointScript(name: string): Step[] {
  const fn = name.replace(/[^a-zA-Z0-9_]/g, "_");
  return [
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
            replace: `@app.get("/${name}")\ndef ${fn}():\n    return {"status": "ok"}\n\n\n@app.get("/items/{item_id}")`,
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
            replace: `def test_${fn}():\n    response = client.get("/${name}")\n    assert response.status_code == 200\n    assert response.json() == {"status": "ok"}\n\n\ndef test_root():`,
          },
        ],
      },
    },
    { say: "Running the tests.", tool: "run_command", args: { command: "python -m pytest -q" } },
    {
      final: (last) =>
        /\b2 passed\b/.test(last) && !/failed/.test(last)
          ? `Added a \`GET /${name}\` endpoint in \`app/main.py\` that returns \`{"status": "ok"}\`, and a test for it in \`tests/test_main.py\`. All tests pass (2 passed).`
          : `The tests did not pass:\n${last.slice(-500)}`,
    },
  ];
}

/** "add a slugify helper": a test that fails on a missing module, the fix, and a green run. */
const SLUGIFY_SCRIPT: Step[] = [
  {
    say: "First a test.",
    tool: "write_file",
    args: {
      path: "tests/test_slug.py",
      content:
        "from app.slug import slugify\n\n\ndef test_slugify():\n    assert slugify('Hello World') == 'hello-world'\n",
    },
  },
  { say: "", tool: "run_command", args: { command: "python -m pytest -q" } },
  {
    say: "The module is missing; adding it.",
    tool: "write_file",
    args: { path: "app/slug.py", content: "def slugify(text):\n    return '-'.join(text.lower().split())\n" },
  },
  { say: "", tool: "run_command", args: { command: "python -m pytest -q" } },
  {
    final: (last) =>
      /\b2 passed\b/.test(last) ? "Added slugify with a test (2 passed)." : `Not yet:\n${last}`,
  },
];

/** "break the root route": like a weak model, it breaks a test and then claims the tests pass. */
const OVERCLAIM_SCRIPT: Step[] = [
  { say: "", tool: "read_file", args: { path: "app/main.py" } },
  {
    say: "",
    tool: "edit_file",
    args: {
      path: "app/main.py",
      edits: [{ search: 'return {"message": "Hello"}', replace: 'return {"status": "OK"}' }],
    },
  },
  { say: "", tool: "run_command", args: { command: "python -m pytest -q" } },
  { final: () => "Done. Tests passed without any issues." },
];

/** A small static page the landing-page scripts write. */
export const LANDING_HTML =
  '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Welcome</title></head>\n<body><main><h1>Welcome</h1><p>Plan your trips in one place.</p></main></body>\n</html>\n';

/** "make a landing page": writes index.html (a static site) and stops. */
const LANDING_SCRIPT: Step[] = [
  { say: "I'll write the page.", tool: "write_file", args: { path: "index.html", content: LANDING_HTML } },
  { final: () => "Added a landing page in `index.html`." },
];

/** "check the landing page": writes it, starts the app and looks at it with check_page. */
const CHECK_SCRIPT: Step[] = [
  { say: "", tool: "write_file", args: { path: "index.html", content: LANDING_HTML } },
  { say: "Starting the app.", tool: "start_preview", args: {} },
  {
    say: "Looking at it in the browser.",
    tool: "check_page",
    args: { url: "/", widths: ["phone", "desktop"], expect_text: "Welcome" },
  },
  { say: "", tool: "stop_preview", args: {} },
  {
    final: () => "Built the landing page and checked it in the browser at two widths.",
  },
];

/** Deterministic bag-of-words vectors, so semantic search can be tested without a model. */
export function fakeEmbedding(text: string, dims = 64): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
    v[(h >>> 0) % dims] += 1;
  }
  return v;
}

function scriptedChat(messages: WireMessage[], stepDelayMs: number): Response {
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
      const endpoint = /add an? \/([a-z][a-z0-9_-]*) endpoint/i.exec(firstUser)?.[1];
      const slug = /slugify helper/.test(firstUser);
      const overclaim = /break the root route/.test(firstUser);
      const landing = /make a landing page/.test(firstUser);
      const checkLanding = /check the landing page/.test(firstUser);
      if (!endpoint && !slug && !overclaim && !landing && !checkLanding) {
        for (const w of words("I can only run the scripted /health demo in this test model.")) {
          ctl.enqueue(line({ message: { role: "assistant", content: w } }));
        }
        finish(12);
        ctl.close();
        return;
      }
      if (stepDelayMs > 0) await Bun.sleep(stepDelayMs);
      const script = checkLanding
        ? CHECK_SCRIPT
        : landing
          ? LANDING_SCRIPT
          : overclaim
            ? OVERCLAIM_SCRIPT
            : slug
              ? SLUGIFY_SCRIPT
              : endpointScript((endpoint ?? "").toLowerCase());
      const step = script[Math.min(toolMsgs.length, script.length - 1)] as Step;
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

/**
 * The memory summary after a task: two useful items, plus two with secrets that Depo must drop
 * (a "password is" sentence and an API key the redactor knows).
 */
export const FAKE_MEMORY_ITEMS = [
  {
    kind: "convention",
    text: "Each route in app/main.py has a matching pytest test in tests/test_main.py.",
  },
  { kind: "decision", text: 'Health checks answer GET /health with {"status": "ok"}.' },
  { kind: "fact", text: "The demo admin password is hunter2-very-secret" },
  { kind: "fact", text: "Tests call the API with key sk-abcdefghijklmnopqrstuvwxyz123456 when needed." },
];

function memoryReply(): Response {
  return new Response(
    new ReadableStream({
      start(ctl) {
        ctl.enqueue(
          line({ message: { role: "assistant", content: JSON.stringify({ items: FAKE_MEMORY_ITEMS }) } }),
        );
        ctl.enqueue(line({ done: true, prompt_eval_count: 400, eval_count: 80, eval_duration: 5e8 }));
        ctl.close();
      },
    }),
  );
}

/** The commit message a local model drafts for applied changes (git.draftCommit). */
export const FAKE_COMMIT = {
  type: "feat",
  scope: "api",
  summary: "add a health check endpoint",
  body: "- add GET /health that answers ok\n- cover it with a test",
};

function jsonReply(value: unknown): Response {
  return new Response(
    new ReadableStream({
      start(ctl) {
        ctl.enqueue(line({ message: { role: "assistant", content: JSON.stringify(value) } }));
        ctl.enqueue(line({ done: true, prompt_eval_count: 300, eval_count: 60, eval_duration: 5e8 }));
        ctl.close();
      },
    }),
  );
}

export interface FakeOllamaOptions {
  /** Delay before each scripted agent step, so concurrent tasks overlap in tests. */
  stepDelayMs?: number;
}

export function startFakeOllama(
  port = 0,
  opts: FakeOllamaOptions = {},
): {
  url: string;
  port: number;
  models: Map<string, number>;
  stop: () => void;
} {
  const models = new Map<string, number>([
    ["qwen2.5-coder:1.5b", 986_000_000],
    ["nomic-embed-text:latest", 274_000_000],
  ]);
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
        case "/api/embed": {
          const { input } = (await req.json()) as { input: string[] };
          return Response.json({ embeddings: input.map((t) => fakeEmbedding(t)) });
        }
        case "/api/delete": {
          const { model } = (await req.json()) as { model: string };
          models.delete(model);
          return new Response(null);
        }
        case "/api/chat": {
          const body = (await req.json()) as { messages: WireMessage[]; tools?: unknown[] };
          if (body.tools?.length) return scriptedChat(body.messages, opts.stepDelayMs ?? 0);
          // Depo's automatic memory asks for durable items as JSON after a task.
          const sys = body.messages.find((m) => m.role === "system")?.content ?? "";
          if (sys.includes("Depo's durable memory")) return memoryReply();
          // Commit messages for applied changes.
          if (sys.includes("git commit messages")) return jsonReply(FAKE_COMMIT);
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
