// Programmatic ingress authentication stays local; the app uses its own service token downstream.
import fs from 'node:fs';
import os from 'node:os';
const base = 'https://jhcmrsah-sfsenorthamerica-beddy.snowflakecomputing.app';
const token = fs.readFileSync(`${os.homedir()}/.snowflake/zelis_c2c_pat`, 'utf8').trim();
const headers = { Authorization: `Snowflake Token="${token}"` };
const paths = process.argv.slice(2);
for (const path of paths.length ? paths : ['/', '/api/persona', '/api/architecture', '/api/exceptions']) {
  const post = path.startsWith('POST:');
  const route = post ? path.slice(5) : path;
  const response = await fetch(`${base}${route}`, { headers: { ...headers, 'Content-Type': 'application/json' },
    method: post ? 'POST' : 'GET', body: post ? (process.env.SMOKE_BODY ?? '{}') : undefined,
    redirect: 'error', signal: AbortSignal.timeout(300000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${text.slice(0, 1000)}`);
  if (path === '/') {
    console.log(JSON.stringify({ path, status: response.status, bytes: text.length }));
    const chunk = text.match(/src="([^\"]*\/_next\/static\/[^\"]+\.js)"/)?.[1];
    if (!chunk) throw new Error('No static JavaScript chunk found');
    const asset = await fetch(`${base}${chunk}`, { headers, redirect: 'error' });
    if (!asset.ok) throw new Error(`Static chunk: ${asset.status}`);
    console.log(JSON.stringify({ static_chunk: chunk, status: asset.status }));
  } else {
    const data = response.headers.get('content-type')?.includes('text/event-stream')
      ? text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
        .filter(event => ['status', 'done', 'error'].includes(event.type))
      : JSON.parse(text);
    if (Array.isArray(data) && response.headers.get('content-type')?.includes('text/event-stream')) {
      const done = data.find(event => event.type === 'done');
      if (data.some(event => event.type === 'error') || !done || done.status !== 'completed' || !done.proposalId)
        throw new Error(`Agent did not complete with a valid proposal: ${JSON.stringify(data)}`);
    }
    console.log(JSON.stringify({ path, status: response.status, data }));
  }
}
