import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';

const app = new Hono();

// Proxy REST API endpoints to the python backend running on port 8000
app.all('/api/*', async (c) => {
  const url = new URL(c.req.url);
  const targetUrl = `http://127.0.0.1:8000${url.pathname}${url.search}`;
  
  const headers = new Headers();
  c.req.raw.headers.forEach((val, key) => {
    headers.set(key, val);
  });
  
  try {
    const body = c.req.method !== 'GET' && c.req.method !== 'HEAD' 
      ? await c.req.raw.blob() 
      : undefined;

    const response = await fetch(targetUrl, {
      method: c.req.method,
      headers: headers,
      body: body,
    });
    
    // Create copy of response headers
    const resHeaders = new Headers();
    response.headers.forEach((val, key) => {
      resHeaders.set(key, val);
    });

    return new Response(response.body, {
      status: response.status,
      headers: resHeaders,
    });
  } catch (err) {
    console.error("Proxy error:", err);
    return c.json({ detail: 'FastAPI backend is currently offline.' }, 502);
  }
});

// Serve frontend client built folder in production
app.use('/*', serveStatic({ root: './dist' }));

const port = 3000;
console.log(`🚀 Hono production gateway listening on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
