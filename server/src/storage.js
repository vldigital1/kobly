// Arquivos públicos por conta. Disco local em STORAGE_DIR.
//   branding   — logo da marca: POST /storage/v1/object/branding/<org>/<arquivo> (só imagens, até 2 MB)
//   flow-media — imagem, vídeo, áudio e arquivo dos blocos de mídia dos fluxos (até 30 MB): o WhatsApp
//                baixa pelo link público GET /storage/v1/object/public/flow-media/<org>/<arquivo>
// O tipo vem do CONTEÚDO (assinatura do arquivo), não do que o navegador diz: HTML/SVG disfarçado é recusado.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { AuthError } from './auth.js';

const MAX_BYTES = 2 * 1024 * 1024;
const MEDIA_MAX = 30 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(png|jpe?g|webp|gif)$/;
const MEDIA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.([a-z0-9]{2,5})$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', '3gp': 'video/3gpp', ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', amr: 'audio/amr',
  pdf: 'application/pdf', doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8' };
// limites do WhatsApp por tipo (documento até 30 MB na Kobly)
const MEDIA_LIMIT = { image: 5, video: 16, audio: 16, document: 30 };

export function sniffImage(buf) {
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.length > 6 && /^GIF8[79]a/.test(buf.subarray(0, 6).toString('latin1'))) return 'gif';
  return null;
}

// Arquivo de mídia → { ext, kind } pelo conteúdo; null se não for um tipo aceito.
export function sniffMedia(buf, nameExt) {
  const img = sniffImage(buf);
  if (img) return { ext: img === 'jpg' ? 'jpg' : img, kind: 'image' };
  const head = buf.subarray(0, 16).toString('latin1');
  if (buf.length > 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (/^M4A|^M4B/.test(brand)) return { ext: 'm4a', kind: 'audio' };
    if (/^3g/.test(brand)) return { ext: '3gp', kind: 'video' };
    return { ext: 'mp4', kind: 'video' };
  }
  if (head.startsWith('OggS')) return { ext: 'ogg', kind: 'audio' };
  if (head.startsWith('#!AMR')) return { ext: 'amr', kind: 'audio' };
  if (head.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && nameExt === 'mp3')) return { ext: 'mp3', kind: 'audio' };
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0 && nameExt === 'aac') return { ext: 'aac', kind: 'audio' };
  if (head.startsWith('%PDF-')) return { ext: 'pdf', kind: 'document' };
  if (head.startsWith('PK\u0003\u0004') && ['docx', 'xlsx', 'pptx'].includes(nameExt)) return { ext: nameExt, kind: 'document' };
  if (buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) && ['doc', 'xls', 'ppt'].includes(nameExt)) return { ext: nameExt, kind: 'document' };
  // texto puro: sem byte nulo e sem cara de HTML/script
  if (['txt', 'csv'].includes(nameExt) && !buf.includes(0) && !/<\s*(html|script|svg|!doctype)/i.test(buf.subarray(0, 2048).toString('utf8'))) return { ext: nameExt, kind: 'document' };
  return null;
}

export function createStorage({ dir, canAccessOrg }) {
  const root = resolve(dir);
  const safe = (org, name, re = NAME) => {
    if (!UUID.test(org) || !re.test(name)) return null;
    const p = resolve(join(root, org, name));
    return p.startsWith(root + sep) ? p : null;
  };
  const bucketDir = (bucket) => (bucket === 'branding' ? '' : bucket); // logo continua na raiz (compatível)
  async function upload(user, bucket, org, name, body) {
    if (bucket !== 'branding' && bucket !== 'flow-media') throw new AuthError(404, 'bucket_not_found', 'Bucket não encontrado.');
    const media = bucket === 'flow-media';
    const p = media ? safe(org, name, MEDIA_NAME) : safe(org, name);
    if (!p) throw new AuthError(400, 'bad_path', media ? 'Nome de arquivo inválido.' : 'Nome de arquivo inválido. Use PNG, JPG, WEBP ou GIF.');
    if (!(await canAccessOrg(user, org))) throw new AuthError(403, 'forbidden', 'Sem acesso a esta conta.');
    if (!body.length) throw new AuthError(400, 'empty', 'Arquivo vazio.');
    if (!media) {
      if (body.length > MAX_BYTES) throw new AuthError(413, 'too_large', 'A imagem passa de 2 MB.');
      if (!sniffImage(body)) throw new AuthError(415, 'bad_type', 'Envie uma imagem PNG, JPG, WEBP ou GIF.');
      await mkdir(join(root, org), { recursive: true });
      await writeFile(p, body, { mode: 0o640 });
      return { path: `${org}/${name}` };
    }
    const ext = name.split('.').pop().toLowerCase();
    const s = sniffMedia(body, ext);
    if (!s) throw new AuthError(415, 'bad_type', 'Tipo de arquivo não aceito. Use imagem (JPG, PNG, WEBP), vídeo MP4, áudio (OGG, MP3, M4A) ou documento (PDF, DOC, DOCX, XLS, XLSX, TXT).');
    if (body.length > MEDIA_LIMIT[s.kind] * 1024 * 1024) throw new AuthError(413, 'too_large', `Arquivo grande demais: o WhatsApp aceita até ${MEDIA_LIMIT[s.kind]} MB para este tipo.`);
    const final = name.replace(/\.[a-z0-9]{2,5}$/i, `.${s.ext}`); // a extensão segue o conteúdo real
    if (!safe(org, final, MEDIA_NAME)) throw new AuthError(400, 'bad_path', 'Nome de arquivo inválido.');
    await mkdir(join(root, bucketDir(bucket), org), { recursive: true });
    await writeFile(resolve(join(root, bucketDir(bucket), org, final)), body, { mode: 0o640 });
    return { path: `${org}/${final}`, kind: s.kind };
  }
  async function read(bucket, org, name) {
    if (bucket !== 'branding' && bucket !== 'flow-media') return null;
    const media = bucket === 'flow-media';
    if (!(media ? safe(org, name, MEDIA_NAME) : safe(org, name))) return null;
    const ext = name.split('.').pop().toLowerCase();
    if (!MIME[ext]) return null;
    try { return { body: await readFile(resolve(join(root, bucketDir(bucket), org, name))), type: MIME[ext], download: media && !/^(image|video|audio)\//.test(MIME[ext]) }; } catch { return null; }
  }
  const maxFor = (bucket) => (bucket === 'flow-media' ? MEDIA_MAX : MAX_BYTES);
  return { upload, read, maxFor, MAX_BYTES };
}
