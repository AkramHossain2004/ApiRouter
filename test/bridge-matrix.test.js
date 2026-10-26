import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * Every client protocol must work against every upstream protocol through the
 * bridges: 4 clients x 4 upstreams, each with a normal and a streaming request.
 * Each upstream is a mock that speaks only its own protocol; the assertion is
 * that the client always gets its own protocol's reply carrying the same text.
 */

const REPLY = "Hi there";
const sse = (lines) => lines.map((l) => (typeof l === "string" ? l : `data: ${JSON.stringify(l)}\n\n`));
const named = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

// ---------------------------------------------------------------- upstreams

const UPSTREAMS = {
  "openai-chat": {
    baseUrl: (root) => `${root}/v1`,
    script: (record) => (record.body?.stream === true
      ? {
          headers: { "content-type": "text/event-stream" },
          stream: sse([
            { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
            { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hi " } }] },
            { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "there" } }] },
            { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
            { id: "c", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } },
            "data: [DONE]\n\n"
          ])
        }
      : {
          body: {
            id: "c", object: "chat.completion", model: "m",
            choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }],
            usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 }
          }
        }),
    path: "/v1/chat/completions"
  },

  anthropic: {
    baseUrl: (root) => root,
    script: (record) => (record.body?.stream === true
      ? {
          headers: { "content-type": "text/event-stream" },
          stream: [
            named("message_start", { message: { id: "msg_1", usage: { input_tokens: 4, output_tokens: 1 } } }),
            named("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
            named("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hi " } }),
            named("content_block_delta", { index: 0, delta: { type: "text_delta", text: "there" } }),
            named("content_block_stop", { index: 0 }),
            named("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
            named("message_stop", {})
          ]
        }
      : {
          body: {
            id: "msg_1", type: "message", role: "assistant", model: "m",
            content: [{ type: "text", text: REPLY }], stop_reason: "end_turn",
            usage: { input_tokens: 4, output_tokens: 5 }
          }
        }),
    path: "/v1/messages"
  },

  "openai-responses": {
    baseUrl: (root) => `${root}/v1`,
    script: (record) => (record.body?.stream === true
      ? {
          headers: { "content-type": "text/event-stream" },
          stream: [
            named("response.created", { response: { status: "in_progress" } }),
            named("response.output_item.added", { output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } }),
            named("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hi " }),
            named("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "there" }),
            named("response.output_text.done", { item_id: "msg_1", output_index: 0, content_index: 0, text: REPLY }),
            named("response.completed", { response: { status: "completed", usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 } } })
          ]
        }
      : {
          body: {
            id: "resp_1", object: "response", status: "completed", model: "m",
            output: [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: REPLY, annotations: [] }] }],
            usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 }
          }
        }),
    path: "/v1/responses"
  },

  gemini: {
    baseUrl: (root) => root,
    script: (record) => (record.url.includes(":streamGenerateContent")
      ? {
          headers: { "content-type": "text/event-stream" },
          stream: sse([
            { candidates: [{ content: { role: "model", parts: [{ text: "Hi " }] } }] },
            { candidates: [{ content: { role: "model", parts: [{ text: "there" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 5, totalTokenCount: 9 } }
          ])
        }
      : {
          body: {
            candidates: [{ content: { role: "model", parts: [{ text: REPLY }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 5, totalTokenCount: 9 }
          }
        }),
    path: "enerateContent" // :generateContent and :streamGenerateContent
  }
};

// ------------------------------------------------------------------ clients

const events = (text) => text.split("\n\n")
  .map((block) => block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""))
  .filter((data) => data && data !== "[DONE]")
  .map((data) => JSON.parse(data));

const CLIENTS = {
  anthropic: {
    request: (stream) => ["/v1/messages", postJson({ model: "any", max_tokens: 32, stream, messages: [{ role: "user", content: "hi" }] })],
    json: (body) => body.content[0].text,
    stream: (text) => events(text).filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join(""),
    streamEnds: (text) => text.includes("message_stop")
  },
  "openai-chat": {
    request: (stream) => ["/v1/chat/completions", postJson({ model: "any", stream, messages: [{ role: "user", content: "hi" }] })],
    json: (body) => body.choices[0].message.content,
    stream: (text) => events(text).map((e) => e.choices?.[0]?.delta?.content ?? "").join(""),
    streamEnds: (text) => text.trimEnd().endsWith("data: [DONE]")
  },
  "openai-responses": {
    request: (stream) => ["/v1/responses", postJson({ model: "any", stream, input: "hi" })],
    json: (body) => body.output[0].content[0].text,
    stream: (text) => events(text).filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join(""),
    streamEnds: (text) => text.includes("response.completed")
  },
  gemini: {
    request: (stream) => [
      stream ? "/v1beta/models/gemini-any:streamGenerateContent?alt=sse" : "/v1beta/models/gemini-any:generateContent",
      postJson({ contents: [{ role: "user", parts: [{ text: "hi" }] }] })
    ],
    json: (body) => body.candidates[0].content.parts[0].text,
    stream: (text) => events(text).flatMap((e) => e.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join(""),
    streamEnds: (text) => /"finishReason":"STOP"/.test(text)
  }
};

for (const [upstreamName, upstream] of Object.entries(UPSTREAMS)) {
  test(`every client protocol works against an upstream that speaks only ${upstreamName}`, async (t) => {
    const mock = await startMockUpstream(upstream.script);
    const router = await startRouter({ PLAYGROUND_ALLOW_PRIVATE_HOSTS: "1" });
    t.after(async () => { await router.close(); await mock.close(); });

    const created = await router.request("/api/custom-endpoints", postJson({
      name: "Only", baseUrl: upstream.baseUrl(mock.baseUrl), protocol: upstreamName, models: ["m"], apiKeys: ["sk-test"]
    }));
    assert.equal(created.status, 201, await created.clone().text());

    for (const [clientName, client] of Object.entries(CLIENTS)) {
      const label = `${clientName} client -> ${upstreamName} upstream`;

      const [path, init] = client.request(false);
      const response = await router.request(path, init);
      const raw = await response.text();
      assert.equal(response.status, 200, `${label} (json): ${raw}`);
      assert.equal(client.json(JSON.parse(raw)), REPLY, `${label} (json)`);

      const [streamPath, streamInit] = client.request(true);
      const streamed = await router.request(streamPath, streamInit);
      const streamedText = await streamed.text();
      assert.equal(streamed.status, 200, `${label} (stream): ${streamedText}`);
      assert.equal(client.stream(streamedText), REPLY, `${label} (stream)`);
      assert.ok(client.streamEnds(streamedText), `${label} (stream) did not end properly: ${streamedText}`);
    }

    // The upstream only ever saw requests in its own protocol.
    const seen = mock.requests.filter((r) => r.method === "POST");
    assert.equal(seen.length, 8);
    assert.ok(seen.every((r) => r.url.includes(upstream.path)), seen.map((r) => r.url).join(", "));
  });
}
