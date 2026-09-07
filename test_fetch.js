fetch('https://prebase.sji.one/api/widget/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ botId: 'a870641c-9dca-49ae-8a3a-a3d3a456bd55', message: 'test' })
}).then(async r => {
  console.log(r.status, r.statusText);
  console.log(await r.text());
}).catch(console.error);
