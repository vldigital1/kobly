// Mídia dos blocos de fluxo: tipo pelo conteúdo, limites do WhatsApp e validação do bloco.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorage, sniffMedia } from '../src/storage.js';
import { validateGraph } from '../src/flows/graph.js';

const ORG = '11111111-2222-4333-8444-555555555555';
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(32)]);
const pdf = Buffer.from('%PDF-1.7\n...conteúdo...');

test('tipo vem do conteúdo, não do nome', () => {
  assert.deepEqual(sniffMedia(png, 'pdf'), { ext: 'png', kind: 'image' });
  assert.deepEqual(sniffMedia(mp4, 'mp4'), { ext: 'mp4', kind: 'video' });
  assert.deepEqual(sniffMedia(Buffer.from('OggS\0\0\0\0\0\0\0\0\0\0\0\0'), 'ogg'), { ext: 'ogg', kind: 'audio' });
  assert.deepEqual(sniffMedia(pdf, 'pdf'), { ext: 'pdf', kind: 'document' });
  assert.deepEqual(sniffMedia(Buffer.from('PK\u0003\u0004resto'), 'docx'), { ext: 'docx', kind: 'document' });
  assert.equal(sniffMedia(Buffer.from('PK\u0003\u0004resto'), 'exe'), null, 'zip qualquer não passa');
  assert.deepEqual(sniffMedia(Buffer.from('linha 1\nlinha 2'), 'txt'), { ext: 'txt', kind: 'document' });
  assert.equal(sniffMedia(Buffer.from('<html><script>alert(1)</script>'), 'txt'), null, 'HTML disfarçado de texto é recusado');
  assert.equal(sniffMedia(Buffer.from('<svg onload=x>'), 'png'), null);
});

test('upload de mídia: extensão corrigida, limites por tipo e arquivo baixável', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kobly-media-'));
  try {
    const st = createStorage({ dir, canAccessOrg: async (u) => u === 'dono' });
    const r = await st.upload('dono', 'flow-media', ORG, 'catalogo.pdf', pdf);
    assert.deepEqual(r, { path: `${ORG}/catalogo.pdf`, kind: 'document' });
    const disf = await st.upload('dono', 'flow-media', ORG, 'foto.pdf', png);
    assert.equal(disf.path, `${ORG}/foto.png`, 'imagem enviada como .pdf vira .png');
    const f = await st.read('flow-media', ORG, 'catalogo.pdf');
    assert.equal(f.type, 'application/pdf'); assert.equal(f.download, true);
    assert.equal((await st.read('flow-media', ORG, 'foto.png')).download, false);
    await assert.rejects(st.upload('outro', 'flow-media', ORG, 'a.pdf', pdf), /Sem acesso/);
    const bigImg = Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)]);
    await assert.rejects(st.upload('dono', 'flow-media', ORG, 'grande.png', bigImg), /até 5 MB/);
    await assert.rejects(st.upload('dono', 'flow-media', ORG, '../x.pdf', pdf), /inválido/);
    await assert.rejects(st.upload('dono', 'outro-bucket', ORG, 'a.pdf', pdf), /Bucket/);
    assert.equal(st.maxFor('flow-media'), 30 * 1024 * 1024);
    assert.equal(st.maxFor('branding'), 2 * 1024 * 1024);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const g = (data, type = 'send_media') => ({ version: 1, start: 'ini', nodes: [
  { ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado'] }, next: { default: 'm' } },
  { ref: 'm', type, data, next: { sent: 'fim' } },
  { ref: 'fim', type: 'end', data: {}, next: {} },
] });
const errs = (graph) => { const r = validateGraph(graph); return r.errors || []; };

test('bloco de mídia e texto: etiqueta de exclusão precisa ser válida', () => {
  const TAG = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  assert.deepEqual(errs(g({ kind: 'image', url: 'https://cdn.x/a.png', delete_on_tag: TAG })), []);
  assert.deepEqual(errs(g({ text: 'Oi', delete_on_tag: TAG }, 'send_text')), []);
  assert.match(errs(g({ text: 'Oi', delete_on_tag: 'qualquer' }, 'send_text')).join(' '), /etiqueta que dispara/);
  assert.deepEqual(errs(g({ kind: 'document', url: 'http://localhost:4120/storage/v1/object/public/flow-media/x/a.pdf' })), [], 'arquivo do ambiente local');
  assert.match(errs(g({ kind: 'document', url: 'http://site.com/a.pdf' })).join(' '), /envie um arquivo ou cole um link/);
});
