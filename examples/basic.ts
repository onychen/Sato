import { AgentRuntime, DemoProvider, createFileTools } from '../src/index.js';

const agent = new AgentRuntime({ provider: new DemoProvider(), tools: createFileTools(), workspace: process.cwd(), mode: 'read-only' });
for await (const event of agent.run('查看当前项目')) {
  if (event.type === 'text') process.stdout.write(event.text);
}
