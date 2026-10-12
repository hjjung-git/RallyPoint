import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";

const message = await client.messages.create({
  model,
  max_tokens: 200,
  messages: [{ role: "user", content: "한 문장으로 인사해줘." }],
});

const first = message.content[0];
console.log(first?.type === "text" ? first.text : message.content);
