fetch('/api/config').then((r) => r.json()).then((c) => {
  if (c.repoUrl) { const a = document.getElementById('repo'); a.href = c.repoUrl; a.textContent = c.repoUrl; }
});
