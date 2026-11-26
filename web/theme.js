// Pin the effective theme before first paint. The app follows system changes so it can capture the outgoing theme.
try {
  const saved = localStorage.getItem('loupe.theme');
  document.documentElement.dataset.theme = saved === '"light"' || saved === '"dark"'
    ? JSON.parse(saved) : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
} catch { /* The stylesheet falls back to the system theme. */ }
// Reduced motion asked of loupe itself (core.js keeps it); the system's own request needs nothing here.
try { if (localStorage.getItem('loupe.motion') === '"reduce"') document.documentElement.dataset.motion = 'reduce'; } catch { /* a private window */ }
