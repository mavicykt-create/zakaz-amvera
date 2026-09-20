const mode = process.env.APP_MODE || 'shop';
if (mode === 'inbox') await import('./inbox-server.js');
else if (mode === 'shop') await import('./server.js');
else throw new Error('APP_MODE must be shop or inbox');
