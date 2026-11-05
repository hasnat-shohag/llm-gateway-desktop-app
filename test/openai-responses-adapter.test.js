'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { once } = require('node:events')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

async function loadGatewayModule(name) {
  return import(pathToFileURL(join(__dirname, '..', 'build', 'gateway', name)).href)
}

function parseEvents(text) {
  const events = []
  const blocks = text.split('\n\n')
  for (const block of blocks) {
    if (!block.trim()) continue
    let event = ''
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim()
      else if (line.startsWith('data: ')) data = line.slice(6).trim()
    }
    if (event && data) {
      try {
        events.push({ event, data: JSON.parse(data) })
      } catch {
        events.push({ event, data })
      }
    }
  }
  return events
}

test('openai-responses adapter translates Anthropic Messages and Responses API both ways', async () => {
  const {
    openAIResponsesUrl,
    isOpenAIResponses,
    toOpenAIResponsesRequest,
    fromOpenAIResponsesResponse,
    createResponsesToAnthropicStream,
  } = await loadGatewayModule('openai-adapter.js')

  // URL builder
  assert.equal(openAIResponsesUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/responses')
  assert.equal(openAIResponsesUrl('https://api.openai.com/v1/responses'), 'https://api.openai.com/v1/responses')
  assert.equal(openAIResponsesUrl('https://agentrouter.org'), 'https://agentrouter.org/v1/responses')

  // Detector
  assert.equal(isOpenAIResponses({ compatibility: 'openai' }), false)
  assert.equal(isOpenAIResponses({ compatibility: 'openai', openai: { apiType: 'responses' } }), true)

  // Request translation
  const provider = {
    name: 'AR',
    baseUrl: 'https://agentrouter.org',
    apiKey: 'sk-test',
    enabled: true,
    weight: 1,
    compatibility: 'openai',
    openai: { apiType: 'responses' },
  }

  const anthropicReq = {
    model: 'gpt-6-astra',
    system: 'You are helpful.',
    messages: [
      { role: 'user', content: 'What is the weather in Tokyo?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: "Let me check." },
          {
            type: 'tool_use',
            id: 'call_123',
            name: 'get_weather',
            input: { city: 'Tokyo' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_123',
            content: 'Sunny, 22C',
          },
        ],
      },
    ],
    tools: [
      {
        name: 'get_weather',
        description: 'Get weather for city',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ],
    stream: true,
  }

  const responsesReq = toOpenAIResponsesRequest(anthropicReq, provider, 'gpt-6-astra')
  assert.equal(responsesReq.model, 'gpt-6-astra')
  assert.equal(responsesReq.instructions, 'You are helpful.')
  assert.equal(responsesReq.stream, true)
  assert.equal(Array.isArray(responsesReq.tools), true)
  assert.equal(responsesReq.tools[0].type, 'function')
  assert.equal(responsesReq.tools[0].name, 'get_weather')
  assert.deepEqual(responsesReq.tools[0].parameters, anthropicReq.tools[0].input_schema)

  // Check input items
  assert.equal(responsesReq.input.length, 4)
  assert.deepEqual(responsesReq.input[0], { role: 'user', content: 'What is the weather in Tokyo?' })
  assert.deepEqual(responsesReq.input[1], { role: 'assistant', content: 'Let me check.' })
  assert.deepEqual(responsesReq.input[2], {
    type: 'function_call',
    call_id: 'call_123',
    name: 'get_weather',
    arguments: JSON.stringify({ city: 'Tokyo' }),
  })
  assert.deepEqual(responsesReq.input[3], {
    type: 'function_call_output',
    call_id: 'call_123',
    output: 'Sunny, 22C',
  })

  // Non-streaming response translation
  const mockResponsesObj = {
    id: 'resp_1',
    model: 'gpt-6-astra',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'It is sunny in Tokyo.' }],
      },
      {
        type: 'function_call',
        call_id: 'call_456',
        name: 'another_tool',
        arguments: '{"a":1}',
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 20,
    },
  }

  const translatedAnthropicResp = fromOpenAIResponsesResponse(mockResponsesObj, 'gpt-6-astra')
  assert.equal(translatedAnthropicResp.id, 'msg_resp_1')
  assert.equal(translatedAnthropicResp.role, 'assistant')
  assert.equal(translatedAnthropicResp.content.length, 2)
  assert.deepEqual(translatedAnthropicResp.content[0], { type: 'text', text: 'It is sunny in Tokyo.' })
  assert.deepEqual(translatedAnthropicResp.content[1], {
    type: 'tool_use',
    id: 'call_456',
    name: 'another_tool',
    input: { a: 1 },
  })
  assert.deepEqual(translatedAnthropicResp.usage, { input_tokens: 10, output_tokens: 20 })

  // Streaming translation
  const stream = createResponsesToAnthropicStream('gpt-6-astra')
  const out = []
  stream.on('data', (c) => out.push(String(c)))

  stream.write('event: response.created\ndata: {"response":{"id":"resp_sse","usage":{"input_tokens":5,"output_tokens":0}}}\n\n')
  stream.write('event: response.output_item.added\ndata: {"item":{"id":"item_1","type":"message","role":"assistant"}}\n\n')
  stream.write('event: response.output_text.delta\ndata: {"delta":"Hello "}\n\n')
  stream.write('event: response.output_text.delta\ndata: {"delta":"world!"}\n\n')
  stream.write('event: response.output_item.added\ndata: {"item":{"id":"item_2","type":"function_call","call_id":"fc_1","name":"tool_x"}}\n\n')
  stream.write('event: response.function_call_arguments.delta\ndata: {"delta":"{\\"foo\\":\\"bar\\"}"}\n\n')
  stream.write('event: response.completed\ndata: {"response":{"usage":{"input_tokens":5,"output_tokens":15}}}\n\n')
  stream.end()

  await once(stream, 'end')
  const events = parseEvents(out.join(''))

  const messageStart = events.find((e) => e.event === 'message_start')
  assert.ok(messageStart)
  assert.equal(messageStart.data.message.model, 'gpt-6-astra')
  assert.equal(messageStart.data.message.usage.input_tokens, 5)

  const textDeltas = events.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta')
  assert.equal(textDeltas.length, 2)
  assert.equal(textDeltas[0].data.delta.text, 'Hello ')
  assert.equal(textDeltas[1].data.delta.text, 'world!')

  const toolDelta = events.find((e) => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta')
  assert.ok(toolDelta)
  assert.equal(toolDelta.data.delta.partial_json, '{"foo":"bar"}')

  const messageDelta = events.find((e) => e.event === 'message_delta')
  assert.ok(messageDelta)
  assert.equal(messageDelta.data.usage.output_tokens, 15)

  const messageStop = events.find((e) => e.event === 'message_stop')
  assert.ok(messageStop)
})
