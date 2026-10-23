#!/usr/bin/env node
// Minimal MCP stdio server for spike 0.7. No dependencies, no network, no credentials.
// Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout and serves fixed "ticket" texts,
// so the PostToolUse payload of mcp__<server>__<tool> can be inspected with known content.
import { createInterface } from 'node:readline';

const TICKET_TEXT = [
  'TICKET LAB-142: Export invoices as CSV',
  'Acceptance: the function exportInvoicesCsv(invoices) returns a string with header "id,amount,currency".',
  'Marker: EVIDENCE-MARKER-7f3a',
].join('\n');

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const tools = [
  {
    name: 'get_ticket',
    description: 'Return the text of a ticket by id (single text block).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'get_ticket_two_blocks',
    description: 'Return a ticket split in two text blocks (no structuredContent).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'get_ticket_mixed',
    description: 'Return a ticket as a text block followed by a 1x1 PNG image block.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'get_ticket_structured',
    description: 'Return a ticket split in two text blocks plus structuredContent.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    outputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, title: { type: 'string' } },
      required: ['id', 'title'],
    },
  },
  {
    name: 'get_ticket_big',
    description: 'Return a very large ticket text of the given number of characters (size test).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, chars: { type: 'number' } },
      required: ['id', 'chars'],
    },
  },
  {
    name: 'get_ticket_error',
    description: 'Always fails with isError: true (error path test).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

function big(chars) {
  const head = `${TICKET_TEXT}\nBIG-START\n`;
  const tail = '\nBIG-END-MARKER-9c1e';
  const fill = 'lorem ipsum dolor sit amet '.repeat(Math.ceil(chars / 27));
  return head + fill.slice(0, Math.max(0, chars - head.length - tail.length)) + tail;
}

function call(name, args) {
  switch (name) {
    case 'get_ticket':
      return { content: [{ type: 'text', text: TICKET_TEXT }] };
    case 'get_ticket_two_blocks':
      return {
        content: [
          { type: 'text', text: 'TICKET LAB-146: Archive invoices' },
          { type: 'text', text: 'Acceptance: archiveInvoices(before) moves old invoices. Marker: TWO-BLOCKS-MARKER-4d21' },
        ],
      };
    case 'get_ticket_mixed':
      return {
        content: [
          { type: 'text', text: 'TICKET LAB-147: Invoice logo. Marker: MIXED-MARKER-8a6f' },
          { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
        ],
      };
    case 'get_ticket_structured':
      return {
        content: [
          { type: 'text', text: 'TICKET LAB-143: Import invoices' },
          { type: 'text', text: 'Acceptance: importInvoicesCsv(text) parses the CSV. Marker: STRUCTURED-MARKER-2b8d' },
        ],
        structuredContent: { id: 'LAB-143', title: 'Import invoices' },
      };
    case 'get_ticket_big':
      return { content: [{ type: 'text', text: big(Number(args?.chars) || 20000) }] };
    case 'get_ticket_error':
      return { content: [{ type: 'text', text: 'ticket backend unavailable: ERROR-MARKER-5e0c' }], isError: true };
    default:
      return null;
  }
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  if (req.id === undefined || req.id === null) return; // notification
  const reply = (result) => send({ jsonrpc: '2.0', id: req.id, result });
  switch (req.method) {
    case 'initialize':
      reply({
        protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'lab-tickets', version: '0.0.1' },
      });
      break;
    case 'ping':
      reply({});
      break;
    case 'tools/list':
      reply({ tools });
      break;
    case 'tools/call': {
      const result = call(req.params?.name, req.params?.arguments);
      if (result) reply(result);
      else send({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: `unknown tool ${req.params?.name}` } });
      break;
    }
    default:
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } });
  }
});
